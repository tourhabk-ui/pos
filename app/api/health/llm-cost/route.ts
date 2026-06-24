/**
 * GET /api/health/llm-cost
 *
 * Отчёт по расходам LLM и качеству RAG-ответов.
 * Auth: requireAdmin
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

const RAG_DEGRADED_THRESHOLD = 3.0; // из 5 баллов

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const today = new Date().toISOString().slice(0, 10);

  const [todayRow, weekRow, byRoute, ragQuality] = await Promise.all([
    pool.query<{ total_tokens: string; cost_usd: string; calls: string }>(
      `SELECT
         COALESCE(SUM(total_tokens), 0)::int      AS total_tokens,
         COALESCE(SUM(estimated_cost_usd), 0)     AS cost_usd,
         COUNT(*)::int                             AS calls
       FROM llm_usage_log
       WHERE created_at >= $1::date
         AND created_at <  $1::date + INTERVAL '1 day'`,
      [today],
    ),

    pool.query<{ total_tokens: string; cost_usd: string; calls: string }>(
      `SELECT
         COALESCE(SUM(total_tokens), 0)::int      AS total_tokens,
         COALESCE(SUM(estimated_cost_usd), 0)     AS cost_usd,
         COUNT(*)::int                             AS calls
       FROM llm_usage_log
       WHERE created_at >= NOW() - INTERVAL '7 days'`,
      [],
    ),

    pool.query<{ route: string; total_tokens: string; cost_usd: string; calls: string }>(
      `SELECT
         route,
         SUM(total_tokens)::int      AS total_tokens,
         SUM(estimated_cost_usd)     AS cost_usd,
         COUNT(*)::int               AS calls
       FROM llm_usage_log
       WHERE created_at >= NOW() - INTERVAL '7 days'
       GROUP BY route
       ORDER BY cost_usd DESC
       LIMIT 20`,
      [],
    ),

    pool.query<{
      count: string;
      avg_relevance: string | null;
      avg_completeness: string | null;
      low_share: string;
    }>(
      `SELECT
         COUNT(*)::int                                                   AS count,
         ROUND(AVG(relevance_score)::numeric, 2)                        AS avg_relevance,
         ROUND(AVG(completeness_score)::numeric, 2)                     AS avg_completeness,
         ROUND(
           COUNT(*) FILTER (WHERE relevance_score <= 2 OR completeness_score <= 2)::numeric
           / NULLIF(COUNT(*), 0), 3
         )                                                               AS low_share
       FROM rag_quality_log
       WHERE created_at >= NOW() - INTERVAL '7 days'`,
      [],
    ),
  ]);

  const t = todayRow.rows[0];
  const w = weekRow.rows[0];
  const rag = ragQuality.rows[0];

  const ragCount = Number(rag?.count ?? 0);
  const ragAvgRelevance = rag?.avg_relevance != null ? Number(rag.avg_relevance) : null;
  const ragAvgCompleteness = rag?.avg_completeness != null ? Number(rag.avg_completeness) : null;
  const ragAvgScore = ragAvgRelevance != null && ragAvgCompleteness != null
    ? Math.round(((ragAvgRelevance + ragAvgCompleteness) / 2) * 100) / 100
    : null;

  return NextResponse.json(
    {
      today: {
        total_tokens: Number(t?.total_tokens ?? 0),
        cost_usd:     Number(t?.cost_usd ?? 0),
        calls:        Number(t?.calls ?? 0),
      },
      week: {
        total_tokens: Number(w?.total_tokens ?? 0),
        cost_usd:     Number(w?.cost_usd ?? 0),
        calls:        Number(w?.calls ?? 0),
      },
      by_route: byRoute.rows.map(r => ({
        route:        r.route,
        total_tokens: Number(r.total_tokens),
        cost_usd:     Number(r.cost_usd),
        calls:        Number(r.calls),
      })),
      rag_quality: {
        count:              ragCount,
        avg_relevance:      ragAvgRelevance,
        avg_completeness:   ragAvgCompleteness,
        avg_score:          ragAvgScore,
        low_score_share:    rag?.low_share != null ? Number(rag.low_share) : 0,
        degraded:           ragAvgScore !== null && ragAvgScore < RAG_DEGRADED_THRESHOLD,
        threshold:          RAG_DEGRADED_THRESHOLD,
      },
      as_of: new Date().toISOString(),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
