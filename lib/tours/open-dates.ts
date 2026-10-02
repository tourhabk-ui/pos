/**
 * Есть ли у тура даты, на которые можно записаться, — для Offer.availability
 * в разметке карточки (аудит vedarai.ru 01.10).
 *
 * Разметка объявляла `InStock` у каждого тура всегда: и вне сезона, и когда
 * все даты разобраны, и когда оператор дат не публиковал вовсе. Выдача
 * обещала «в наличии» тому, кто потом не находил ни одной даты.
 *
 * Отбор дат тот же, что у витрины дат в форме брони (GET /api/tours/[id]/slots):
 * год вперёд, не отменённые, не удалённые, вместимость с потолком
 * max_participants (`freeSlotsSql`), занятость — общим правилом `occupiedOnDaySql`.
 *
 * Три ответа и четвёртый — «не смогли спросить» (§4.0):
 * - есть свободная дата — `InStock`;
 * - даты есть, свободных нет — `SoldOut`;
 * - дат не записано — `null`: оператор работает по запросу или ещё не
 *   опубликовал даты, и утверждать в разметке нечего;
 * - запрос упал — `null` и строка в логе.
 */
import { pool } from '@/lib/db-pool';
import { occupiedOnDaySql, freeSlotsSql } from '@/lib/bookings/occupancy';

export type OfferAvailability = 'https://schema.org/InStock' | 'https://schema.org/SoldOut';

export interface DatesCount {
  recorded: number;
  open: number;
}

/** Ответ разметки по счёту дат. */
export function availabilityFromDates(c: DatesCount | null): OfferAvailability | null {
  if (c === null || c.recorded === 0) return null;
  return c.open > 0 ? 'https://schema.org/InStock' : 'https://schema.org/SoldOut';
}

export async function countTourDates(tourId: number): Promise<DatesCount | null> {
  try {
    const { rows } = await pool.query<{ recorded: string; open: string }>(
      `SELECT
         COUNT(*)::text AS recorded,
         COUNT(*) FILTER (
           WHERE ${freeSlotsSql('ta', 'ot', 'occ.taken')} > 0
         )::text AS open
       FROM tour_availability ta
       JOIN operator_tours ot ON ot.id = ta.operator_tour_id
       CROSS JOIN LATERAL (
         ${occupiedOnDaySql({ booking: 'ob', day: 'ta.date', tourId: 'ta.operator_tour_id' })}
       ) occ
       WHERE ta.operator_tour_id = $1
         AND ta.date >= CURRENT_DATE
         AND ta.is_cancelled = false
         AND ta.deleted_at IS NULL
         AND ta.date <= CURRENT_DATE + INTERVAL '1 year'`,
      [tourId],
    );
    const r = rows[0];
    return { recorded: Number(r?.recorded ?? 0), open: Number(r?.open ?? 0) };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[open-dates] даты тура не сосчитаны', { tourId, sqlstate: e?.code, message: e?.message });
    return null;
  }
}
