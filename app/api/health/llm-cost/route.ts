/**
 * GET /api/health/llm-cost
 *
 * Агрегированный отчёт по расходам LLM и качеству RAG-ответов за 7 дней.
 * Используется для мониторинга деградации качества и контроля затрат.
 *
 * rag_quality.degraded = true когда avg_score < RAG_DEGRADED_THRESHOLD (0.6)
 *
 * Auth: requireAdmin
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

const RAG_DEGRADED_THRESHOLD = 0.6;
const LOW_SCORE_THRESHOLD = 0.5;

interface LlmCostRow {
  route: string;
  day: Date;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: string;
  calls: number;
}

interface LlmSummaryRow {
  total_tokens: number | null;
  cost_usd: string | null;
  total_calls: number | null;
}

interface RagQualityRow {
  avg_score: string | null;
  count: string;
  low_score_count: string;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const [daily, summary, ragQuality] = await Promise.all([
    pool.query<LlmCostRow>(`
      SELECT
        route,
        DATE_TRUNC('day', created_at)  AS day,
        SUM(prompt_tokens)::int        AS prompt_tokens,
        SUM(completion_tokens)::int    AS completion_tokens,
        SUM(total_tokens)::int         AS total_tokens,
        SUM(estimated_cost_usd)        AS cost_usd,
        COUNT(*)::int                  AS calls
      FROM llm_usage_log
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY route, day
      ORDER BY day DESC, cost_usd DESC
    `),

    pool.query<LlmSummaryRow>(`
      SELECT
        SUM(total_tokens)::int      AS total_tokens,
        SUM(estimated_cost_usd)     AS cost_usd,
        COUNT(*)::int               AS total_calls
      FROM llm_usage_log
      WHERE created_at > NOW() - INTERVAL '7 days'
    `),

    pool.query<RagQualityRow>(`
      SELECT
        AVG((metadata->>'score')::float)::text                                        AS avg_score,
        COUNT(*)::text                                                                 AS count,
        COUNT(*) FILTER (WHERE (metadata->>'score')::float < $1)::text               AS low_score_count
      FROM ai_actions_log
      WHERE action_type = 'rag_judge'
        AND created_at > NOW() - INTERVAL '7 days'
    `, [LOW_SCORE_THRESHOLD]),
  ]);

  const rag = ragQuality.rows[0];
  const ragCount = parseInt(rag?.count ?? '0', 10);
  const ragAvgScore = rag?.avg_score != null ? parseFloat(rag.avg_score) : null;
  const ragLowCount = parseInt(rag?.low_score_count ?? '0', 10);

  return NextResponse.json({
    ok: true,
    period: '7d',
    llm_cost: {
      daily: daily.rows,
      summary: {
        total_tokens: summary.rows[0]?.total_tokens ?? 0,
        cost_usd: parseFloat(summary.rows[0]?.cost_usd ?? '0'),
        total_calls: summary.rows[0]?.total_calls ?? 0,
      },
    },
    rag_quality: {
      avg_score: ragAvgScore !== null ? Math.round(ragAvgScore * 1000) / 1000 : null,
      count: ragCount,
      low_score_share: ragCount > 0 ? Math.round((ragLowCount / ragCount) * 1000) / 1000 : 0,
      degraded: ragAvgScore !== null && ragAvgScore < RAG_DEGRADED_THRESHOLD,
      threshold: RAG_DEGRADED_THRESHOLD,
    },
  });
}
