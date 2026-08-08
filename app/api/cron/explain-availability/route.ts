/**
 * GET /api/cron/explain-availability?tour=6&days=14
 *
 * Диагностика планировщика запросов для приёмки индексов 843 (перф-аудит
 * 08.08, п.7 «как измерить»): EXPLAIN (ANALYZE, BUFFERS) того же запроса
 * занятости, что исполняет fetchAvailabilityForTour. Из песочницы прод-БД
 * недоступна — «глазами» служит probe-url через этот эндпоинт.
 *
 * Read-only по построению: EXPLAIN ANALYZE исполняет ТОЛЬКО SELECT.
 * Секрет-гейт как у остальных cron-диагностик.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { verifyCronSecret } from '@/lib/auth/cron';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const tourRaw = req.nextUrl.searchParams.get('tour') ?? '6';
  if (!/^\d{1,10}$/.test(tourRaw)) {
    return NextResponse.json({ error: 'tour — числовой ID' }, { status: 400 });
  }
  const daysRaw = parseInt(req.nextUrl.searchParams.get('days') ?? '14', 10);
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 31) : 14;

  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + (days - 1) * 86400000).toISOString().slice(0, 10);

  try {
    // Тот же SQL, что в lib/planner/data.ts (fetchAvailabilityForTour) —
    // меряем боевой запрос, а не похожий.
    const { rows } = await pool.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, BUFFERS)
       SELECT
          ta.date::text,
          ta.available_slots,
          occ.taken AS booked_slots,
          GREATEST(0, LEAST(ta.available_slots, COALESCE(ot.max_participants, ta.available_slots)) - occ.taken) AS remaining,
          ta.base_price_override AS price_override
        FROM tour_availability ta
        JOIN operator_tours ot ON ot.id = ta.operator_tour_id
        CROSS JOIN LATERAL (
          SELECT COALESCE(SUM(ob.participants), 0)::int AS taken
          FROM operator_bookings ob
          WHERE ob.operator_tour_id = ta.operator_tour_id
            AND ob.booking_date = ta.date
            AND ob.booking_status NOT IN ('cancelled', 'rejected')
        ) occ
        WHERE ta.operator_tour_id = $1
          AND ta.date BETWEEN $2::date AND $3::date
          AND ta.is_cancelled = FALSE
          AND ta.deleted_at IS NULL
          AND GREATEST(0, LEAST(ta.available_slots, COALESCE(ot.max_participants, ta.available_slots)) - occ.taken) > 0
        ORDER BY ta.date ASC`,
      [tourRaw, from, to],
    );

    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    return NextResponse.json({
      ok: true,
      tour: Number(tourRaw),
      window: { from, to },
      // Флаги приёмки: сели ли горячие пути на индексы 843
      uses_availability_index: plan.includes('idx_tour_availability_tour_date'),
      uses_bookings_index: plan.includes('idx_operator_bookings_tour_date_active'),
      has_seq_scan_on_bookings: /Seq Scan on (public\.)?operator_bookings/.test(plan),
      plan,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
