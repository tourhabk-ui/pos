/**
 * GET /api/admin/analytics/ai-usage — активность и стоимость AI-агентов
 * из журнала ai_actions_log.
 *
 * ЧЕСТНО О ДАННЫХ: колонки tokens_in/tokens_out/cost_usd в схеме есть
 * (миграции 059/687/691), но НИ ОДИН insert их сейчас не заполняет — все
 * пишут только action_type + metadata. Поэтому «стоимость» вернётся нулевой,
 * а признак `cost_instrumented` говорит правду: инструментации расходов в
 * waterfall пока нет. Активность (сколько раз какой агент отработал, по
 * провайдерам, во времени) — реальная. Не выдумываем рубли, которых нет.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { safeMsg } from '@/lib/errors/sanitize';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const [totals, byType, byProvider, daily] = await Promise.all([
      pool.query<{
        today: string; week: string; month: string;
        cost_rows: string; cost_sum: string | null;
        tokens_in: string | null; tokens_out: string | null;
      }>(`
        SELECT
          COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)                       AS today,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')          AS week,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')         AS month,
          COUNT(*) FILTER (WHERE cost_usd IS NOT NULL
                             AND created_at >= NOW() - INTERVAL '30 days')         AS cost_rows,
          COALESCE(SUM(cost_usd) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'), 0)::float8   AS cost_sum,
          COALESCE(SUM(tokens_in) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'), 0)::float8  AS tokens_in,
          COALESCE(SUM(tokens_out) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days'), 0)::float8 AS tokens_out
        FROM ai_actions_log
      `),
      pool.query<{ action_type: string; cnt: string }>(`
        SELECT action_type, COUNT(*) AS cnt
        FROM ai_actions_log
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY action_type
        ORDER BY cnt DESC
        LIMIT 20
      `),
      pool.query<{ provider: string | null; cnt: string }>(`
        SELECT provider, COUNT(*) AS cnt
        FROM ai_actions_log
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY provider
        ORDER BY cnt DESC
        LIMIT 12
      `),
      pool.query<{ day: string; cnt: string }>(`
        SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day, COUNT(*) AS cnt
        FROM ai_actions_log
        WHERE created_at >= NOW() - INTERVAL '14 days'
        GROUP BY created_at::date
        ORDER BY created_at::date DESC
      `),
    ]);

    const t = totals.rows[0];
    return NextResponse.json({
      success: true,
      data: {
        totals: {
          today: Number(t.today),
          week:  Number(t.week),
          month: Number(t.month),
        },
        cost: {
          // Инструментирована ли стоимость: есть ли хоть одна строка с cost_usd
          instrumented: Number(t.cost_rows) > 0,
          usd_30d:      Number(t.cost_sum ?? 0),
          tokens_in_30d:  Number(t.tokens_in ?? 0),
          tokens_out_30d: Number(t.tokens_out ?? 0),
        },
        by_action_type: byType.rows.map(r => ({ action_type: r.action_type, count: Number(r.cnt) })),
        by_provider: byProvider.rows.map(r => ({ provider: r.provider ?? '—', count: Number(r.cnt) })),
        daily: daily.rows.map(r => ({ day: r.day, count: Number(r.cnt) })),
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: safeMsg(error) }, { status: 500 });
  }
}
