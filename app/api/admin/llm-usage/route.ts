import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const [daily, summary] = await Promise.all([
    pool.query(`
      SELECT
        route,
        DATE_TRUNC('day', created_at)   AS day,
        SUM(prompt_tokens)::int         AS prompt_tokens,
        SUM(completion_tokens)::int     AS completion_tokens,
        SUM(total_tokens)::int          AS total_tokens,
        SUM(estimated_cost_usd)         AS cost_usd,
        COUNT(*)::int                   AS calls
      FROM llm_usage_log
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY route, day
      ORDER BY day DESC, cost_usd DESC
    `),
    pool.query(`
      SELECT
        SUM(total_tokens)::int      AS total_tokens,
        SUM(estimated_cost_usd)     AS cost_usd,
        COUNT(*)::int               AS total_calls
      FROM llm_usage_log
      WHERE created_at > NOW() - INTERVAL '7 days'
    `),
  ]);

  return NextResponse.json({ rows: daily.rows, summary: summary.rows[0] });
}
