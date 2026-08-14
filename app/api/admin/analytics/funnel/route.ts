/**
 * GET /api/admin/analytics/funnel — именованные шаги воронки и NSM
 * «активированные поездки» (стратегия 14.08).
 *
 * Источник — funnel_events (маяк взаимодействий); словарь шагов один на
 * платформу: lib/funnel/steps.ts. Просмотры сюда не входят — они в
 * /api/admin/analytics/traffic из page_views.
 *
 * Честность подсчёта NSM: visitor_hash СУТОЧНЫЙ (в нём дата — 152-ФЗ,
 * длинный профиль не строим), поэтому «получил результат И сделал действие»
 * сшивается только внутри одного дня. Недельная цифра — СУММА человеко-дней
 * с результатом и действием в один день, а не «уникальные люди за неделю»:
 * тот же человек в два разных дня даст два. Это то же самое ограничение,
 * что у visitor_days в traffic, и названо оно тем же словом.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { safeMsg } from '@/lib/errors/sanitize';
import { FUNNEL_STEPS, EXECUTION_STEPS } from '@/lib/funnel/steps';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const exec = EXECUTION_STEPS as readonly string[];
    const [bySteps, activated, activatedDaily] = await Promise.all([
      // Счётчики по шагам: события и человеко-дни, 7 и 30 суток.
      pool.query<{ step: string; events_7d: string; days_7d: string; events_30d: string; days_30d: string }>(
        `SELECT step,
                COUNT(*)                    FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')  AS events_7d,
                COUNT(DISTINCT visitor_hash) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')  AS days_7d,
                COUNT(*)                    FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS events_30d,
                COUNT(DISTINCT visitor_hash) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS days_30d
           FROM funnel_events
          WHERE created_at >= NOW() - INTERVAL '30 days'
          GROUP BY step`,
      ),
      // NSM: человеко-дни, где в ОДИН день есть результат планировщика и
      // хотя бы одно действие исполнения.
      pool.query<{ activated_7d: string; activated_30d: string }>(
        `SELECT
           COUNT(DISTINCT r.visitor_hash) FILTER (WHERE r.created_at >= NOW() - INTERVAL '7 days')  AS activated_7d,
           COUNT(DISTINCT r.visitor_hash) FILTER (WHERE r.created_at >= NOW() - INTERVAL '30 days') AS activated_30d
           FROM funnel_events r
          WHERE r.step = 'planner_result_viewed'
            AND r.created_at >= NOW() - INTERVAL '30 days'
            AND EXISTS (
              SELECT 1 FROM funnel_events e
               WHERE e.visitor_hash = r.visitor_hash
                 AND e.step = ANY($1::text[])
            )`,
        [exec],
      ),
      // Ряд по дням за 14 суток — для еженедельного growth-обзора.
      pool.query<{ day: string; activated: string }>(
        `SELECT DATE(r.created_at)::text AS day,
                COUNT(DISTINCT r.visitor_hash) AS activated
           FROM funnel_events r
          WHERE r.step = 'planner_result_viewed'
            AND r.created_at >= NOW() - INTERVAL '14 days'
            AND EXISTS (
              SELECT 1 FROM funnel_events e
               WHERE e.visitor_hash = r.visitor_hash
                 AND e.step = ANY($1::text[])
            )
          GROUP BY DATE(r.created_at)
          ORDER BY day`,
        [exec],
      ),
    ]);

    // Все шаги словаря присутствуют в ответе, даже с нулями: отсутствие
    // строки читалось бы как «шаг не существует», а это разные вещи.
    const found = new Map(bySteps.rows.map((r) => [r.step, r]));
    const steps = FUNNEL_STEPS.map((step) => {
      const r = found.get(step);
      return {
        step,
        events_7d: Number(r?.events_7d ?? 0),
        visitor_days_7d: Number(r?.days_7d ?? 0),
        events_30d: Number(r?.events_30d ?? 0),
        visitor_days_30d: Number(r?.days_30d ?? 0),
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        steps,
        activated_trips: {
          window_note: 'человеко-дни: результат планировщика и действие исполнения в один день (суточный visitor_hash, 152-ФЗ)',
          activated_7d: Number(activated.rows[0]?.activated_7d ?? 0),
          activated_30d: Number(activated.rows[0]?.activated_30d ?? 0),
          daily_14d: activatedDaily.rows.map((r) => ({ day: r.day, activated: Number(r.activated) })),
        },
      },
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: safeMsg(e, 'Не удалось прочитать воронку') },
      { status: 500 },
    );
  }
}
