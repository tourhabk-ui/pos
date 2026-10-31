/**
 * Закрыть даты тура для продажи — одно выражение для календаря оператора
 * (`POST /api/operator/calendar/block`) и для гида в чате кабинета
 * (lib/guides/own-dates, 30.10).
 *
 * Владение — в самом запросе: даты пишутся только туру этой карточки, не
 * удалённому. Чужой тур — `tour_not_found`, ни строки не записано. Брони на
 * закрытую дату это не отменяет: закрытие снимает дату с продажи. Новая
 * строка календаря получает ноль мест (миграция 1307: ноль мест — у закрытой
 * даты), у существующей места не трогаются.
 */
import type { PoolClient } from 'pg';

export type CloseDatesResult =
  | { ok: true; closed: number }
  | { ok: false; reason: 'tour_not_found' }
  | { ok: false; reason: 'failed'; sqlstate: string | null };

export const CLOSE_DATES_SQL = `
  WITH own AS (
    SELECT id FROM operator_tours
     WHERE id = $1::bigint AND operator_id = $2::uuid AND deleted_at IS NULL
  ), written AS (
    INSERT INTO tour_availability (operator_tour_id, date, available_slots, is_cancelled, cancellation_reason)
    SELECT own.id, d, 0, true, $4::text
      FROM own CROSS JOIN unnest($3::date[]) AS d
    ON CONFLICT (operator_tour_id, date) DO UPDATE SET
      is_cancelled        = true,
      cancellation_reason = EXCLUDED.cancellation_reason,
      updated_at          = NOW()
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM own)::int AS owned, (SELECT count(*) FROM written)::int AS closed`;

export async function closeTourDates(
  db: Pick<PoolClient, 'query'>,
  input: { operatorId: string; tourId: string | number; dates: string[]; reason: string },
): Promise<CloseDatesResult> {
  try {
    const { rows } = await db.query<{ owned: number; closed: number }>(CLOSE_DATES_SQL, [
      String(input.tourId), input.operatorId, input.dates, input.reason,
    ]);
    const r = rows[0];
    if (!r || Number(r.owned) === 0) return { ok: false, reason: 'tour_not_found' };
    return { ok: true, closed: Number(r.closed) };
  } catch (err) {
    const sqlstate = (err as { code?: string } | null)?.code ?? null;
    console.error('[tour-dates] даты не закрыты, SQLSTATE', sqlstate ?? 'нет SQLSTATE');
    return { ok: false, reason: 'failed', sqlstate };
  }
}
