/**
 * GET /api/cron/booking-attempts?secret=<CRON_SECRET>&days=90
 *
 * Сколько раз пытались забронировать и сколько не дошло. Только чтение.
 *
 * ГЛАВНОЕ, ЧТО ЭТА ПЕРЕПИСЬ ГОВОРИТ ВСЛУХ. Полного числа попыток за прошлое
 * НЕТ И НЕ БУДЕТ. Попытку — касание формы брони — измерял шаг `booking_start`
 * маяка воронки, а приёмник маяка не выполнил свой INSERT ни разу с миграции
 * 839: PostgreSQL отвечал 42P08 (см. CLAUDE.md §4.0, случай 24.08). Ноль в
 * этом счётчике был фактом о нас, а не о туристах, и выводить попытки из
 * конверсий задним числом — то же самое выдумывание, за которое мы правим
 * Editor. Поэтому `form_touches` отвечает `null`, пока в `funnel_events` нет
 * ни одной строки, а `measurable_since` называет дату, с которой счёт
 * ЧЕСТНЫЙ.
 *
 * ЧТО ВСЁ-ТАКИ ЕСТЬ. Три следа, каждый со своим смыслом:
 *   - доведённая до конца попытка — строка в `operator_bookings`; не дошла
 *     до денег — та, у которой `paid_at` пуст;
 *   - сорванная попытка — 500 на маршрутах брони из журнала onRequestError
 *     (`ai_actions_log`, action_type='server_error'). Это НЕ все неудачи:
 *     отказ валидации (400) и уход со страницы туда не попадают;
 *   - заявка вместо брони — строка в `leads`.
 *
 * Сумма этих трёх — не «число попыток». Это три разных следа трёх разных
 * судеб, и складывать их в одно число значит получить цифру, за которой не
 * стоит ничего.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic     = 'force-dynamic';
export const maxDuration = 60;

/** Маршруты, через которые бронь вообще может быть создана. */
export const BOOKING_ROUTES = [
  '/api/hub/bookings/create',  // форма на карточке тура (BookingFormClient)
  '/api/bookings/tour',        // оплата из модального окна (TourPaymentModal)
  '/api/tours/[id]/book',
  '/api/hub/operator/bookings',
] as const;

export interface Measured<T> { value: T | null; failed: string | null }

async function measure<T>(name: string, fn: () => Promise<T>): Promise<Measured<T>> {
  try {
    return { value: await fn(), failed: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'неизвестная ошибка';
    console.error(`[booking-attempts] замер «${name}» не удался:`, msg);
    return { value: null, failed: msg };
  }
}

export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  const raw = Number(req.nextUrl.searchParams.get('days') ?? 90);
  const days = Number.isFinite(raw) ? Math.min(365, Math.max(1, Math.trunc(raw))) : 90;
  const W = `NOW() - ($1 || ' days')::INTERVAL`;

  const [beacon, bookings, unpaid, errors, leads] = await Promise.all([
    // С какого момента счёт попыток вообще становится честным.
    measure('funnel_events.beacon', async () => (await pool.query<{
      first_at: string | null; total: number; touches: number;
    }>(
      `SELECT MIN(created_at)::text AS first_at,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE step = 'booking_start')::int AS touches
         FROM funnel_events`,
    )).rows[0]),

    measure('operator_bookings', async () => (await pool.query<{
      booking_status: string | null; n: number; paid: number;
    }>(
      `SELECT booking_status, COUNT(*)::int AS n, COUNT(paid_at)::int AS paid
         FROM operator_bookings
        WHERE created_at > ${W}
        GROUP BY booking_status
        ORDER BY n DESC`,
      [days],
    )).rows),

    // Не дошли до денег: бронь есть, оплаты нет. Возраст важен — вчерашняя
    // неоплаченная бронь и полугодовая означают разное.
    measure('unpaid', async () => (await pool.query<{
      id: string; booking_status: string | null; created_at: string; age_hours: number;
    }>(
      `SELECT id::text,
              booking_status,
              created_at::text,
              ROUND(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600)::int AS age_hours
         FROM operator_bookings
        WHERE created_at > ${W}
          AND paid_at IS NULL
        ORDER BY created_at DESC
        LIMIT 50`,
      [days],
    )).rows),

    // Сорванные попытки: 500 на маршрутах брони. Журнал onRequestError.
    measure('server_errors', async () => (await pool.query<{
      route: string | null; n: number; last_message: string | null; last_at: string | null;
    }>(
      `SELECT metadata->>'route' AS route,
              COUNT(*)::int AS n,
              (ARRAY_AGG(metadata->>'message' ORDER BY created_at DESC))[1] AS last_message,
              MAX(created_at)::text AS last_at
         FROM ai_actions_log
        WHERE action_type = 'server_error'
          AND created_at > ${W}
          AND metadata->>'route' = ANY($2::text[])
        GROUP BY 1
        ORDER BY n DESC`,
      [days, BOOKING_ROUTES as unknown as string[]],
    )).rows),

    measure('leads', async () => (await pool.query<{ status: string | null; n: number }>(
      `SELECT status, COUNT(*)::int AS n FROM leads
        WHERE created_at > ${W} GROUP BY status ORDER BY n DESC`,
      [days],
    )).rows),
  ]);

  const created = (bookings.value ?? []).reduce((s, r) => s + r.n, 0);
  const paid    = (bookings.value ?? []).reduce((s, r) => s + r.paid, 0);
  const beaconRows = beacon.value?.total ?? null;

  const failures = [beacon, bookings, unpaid, errors, leads].filter((m) => m.failed).length;

  return NextResponse.json({
    ok: true,
    probe: 'booking_attempts_v1',
    window_days: days,

    // Попытка = касание формы. Меряется только маяком, и до его починки
    // 24.08 не мерялась вовсе. Ноль здесь запрещён: это «не знаю».
    form_touches: beaconRows && beaconRows > 0 ? (beacon.value?.touches ?? null) : null,
    measurable_since: beacon.value?.first_at ?? null,
    why_unmeasurable: beaconRows === 0
      ? 'Приёмник маяка отвечал 42P08 и не записал ни одной строки с миграции 839. Число попыток за прошлое не восстановимо.'
      : null,

    // Доведённые до конца попытки и их судьба.
    bookings_created: bookings.value ? created : null,
    bookings_paid:    bookings.value ? paid : null,
    bookings_unpaid:  bookings.value ? created - paid : null,
    bookings_by_status: bookings.value,
    unpaid_list: unpaid.value,

    // Сорванные попытки — но только те, что упали пятисоткой.
    failed_with_500: errors.value,
    failed_500_total: errors.value ? errors.value.reduce((s, r) => s + r.n, 0) : null,
    not_counted_as_failure: 'отказ валидации (400), закрытая вкладка, передумал — следа не оставляют',

    leads_by_status: leads.value,

    failed_measures: [
      ['funnel_events', beacon], ['operator_bookings', bookings], ['unpaid', unpaid],
      ['server_errors', errors], ['leads', leads],
    ].filter(([, m]) => (m as Measured<unknown>).failed)
     .map(([name, m]) => ({ measure: name, error: (m as Measured<unknown>).failed })),

    meaningful: failures === 0,
    duration_ms: Date.now() - startedAt,
  });
}
