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
        COUNT(*)::int                   AS calls,
        -- #1862: SUM(estimated_cost_usd) молча пропускает NULL («цену не
        -- знаем», миграция 961) — без этого числа cost_usd у модели вне
        -- каталога читался бы как «дёшево», а не «не посчитано».
        COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL)::int AS unknown_cost_calls
      FROM llm_usage_log
      WHERE created_at > NOW() - INTERVAL '7 days'
      GROUP BY route, day
      ORDER BY day DESC, cost_usd DESC
    `),
    pool.query(`
      SELECT
        SUM(total_tokens)::int      AS total_tokens,
        SUM(estimated_cost_usd)     AS cost_usd,
        COUNT(*)::int               AS total_calls,
        COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL)::int AS unknown_cost_calls
      FROM llm_usage_log
      WHERE created_at > NOW() - INTERVAL '7 days'
    `),
  ]);

  return NextResponse.json({ rows: daily.rows, summary: summary.rows[0] });
}
