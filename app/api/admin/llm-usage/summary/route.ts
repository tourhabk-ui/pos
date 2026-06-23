import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = req.nextUrl;
  const parsed = QuerySchema.safeParse({
    from: searchParams.get('from') ?? undefined,
    to: searchParams.get('to') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'Некорректный формат дат (ожидается YYYY-MM-DD)' }, { status: 400 });
  }

  const from = parsed.data.from ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const to = parsed.data.to ?? new Date().toISOString().slice(0, 10);

  const [daily, byRoute, total] = await Promise.all([
    pool.query(`
      SELECT
        DATE(created_at)            AS day,
        route,
        SUM(prompt_tokens)::int     AS prompt_tokens,
        SUM(completion_tokens)::int AS completion_tokens,
        SUM(total_tokens)::int      AS total_tokens,
        SUM(estimated_cost_usd)     AS cost_usd,
        COUNT(*)::int               AS calls
      FROM llm_usage_log
      WHERE created_at >= $1::date
        AND created_at <  $2::date + INTERVAL '1 day'
      GROUP BY DATE(created_at), route
      ORDER BY day DESC, cost_usd DESC
    `, [from, to]),

    pool.query(`
      SELECT
        route,
        SUM(total_tokens)::int  AS total_tokens,
        SUM(estimated_cost_usd) AS cost_usd,
        COUNT(*)::int           AS calls
      FROM llm_usage_log
      WHERE created_at >= $1::date
        AND created_at <  $2::date + INTERVAL '1 day'
      GROUP BY route
      ORDER BY cost_usd DESC
    `, [from, to]),

    pool.query(`
      SELECT
        SUM(total_tokens)::int  AS total_tokens,
        SUM(estimated_cost_usd) AS total_cost,
        COUNT(*)::int           AS total_calls
      FROM llm_usage_log
      WHERE created_at >= $1::date
        AND created_at <  $2::date + INTERVAL '1 day'
    `, [from, to]),
  ]);

  return NextResponse.json({
    period: { from, to },
    daily: daily.rows,
    by_route: byRoute.rows,
    total_cost: total.rows[0]?.total_cost ?? 0,
    total_tokens: total.rows[0]?.total_tokens ?? 0,
    total_calls: total.rows[0]?.total_calls ?? 0,
  });
}
