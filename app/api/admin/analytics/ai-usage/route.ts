/**
 * GET /api/admin/analytics/ai-usage — активность AI-агентов из журнала
 * ai_actions_log: сколько раз какое действие отработало, каким провайдером,
 * по дням. Вкладка «Активность» страницы «Расходы AI».
 *
 * Денег здесь нет и не было: колонки tokens_in/tokens_out/cost_usd в схеме
 * есть (миграции 059/687/691), но cost_usd не пишет ни один insert, и до 07.11
 * этот роут отдавал по ней «стоимость», а страница — «стоимость пока не
 * пишется», хотя расход давно пишут книги llm_usage_log. Деньги — роут
 * /api/admin/health/ai-money и вкладка «Деньги» (владелец 07.11: «наведи
 * порядок в этом разделе»).
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
      pool.query<{ today: string; week: string; month: string }>(`
        SELECT
          COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)                       AS today,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')          AS week,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')         AS month
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
        by_action_type: byType.rows.map(r => ({ action_type: r.action_type, count: Number(r.cnt) })),
        by_provider: byProvider.rows.map(r => ({ provider: r.provider ?? '—', count: Number(r.cnt) })),
        daily: daily.rows.map(r => ({ day: r.day, count: Number(r.cnt) })),
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: safeMsg(error) }, { status: 500 });
  }
}
