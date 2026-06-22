import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const today = new Date().toISOString().slice(0, 10);

  const [todayRow, weekRow, byRoute] = await Promise.all([
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
  ]);

  const t = todayRow.rows[0];
  const w = weekRow.rows[0];

  return NextResponse.json(
    {
      today: {
        total_tokens: Number(t?.total_tokens ?? 0),
        cost_usd: Number(t?.cost_usd ?? 0),
        calls: Number(t?.calls ?? 0),
      },
      week: {
        total_tokens: Number(w?.total_tokens ?? 0),
        cost_usd: Number(w?.cost_usd ?? 0),
        calls: Number(w?.calls ?? 0),
      },
      by_route: byRoute.rows.map(r => ({
        route: r.route,
        total_tokens: Number(r.total_tokens),
        cost_usd: Number(r.cost_usd),
        calls: Number(r.calls),
      })),
      as_of: new Date().toISOString(),
    },
    {
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
