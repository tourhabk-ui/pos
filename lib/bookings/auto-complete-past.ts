/**
 * Тур завершается сам на следующий день после даты (решение владельца 13.10:
 * «тур завершать автоматически»).
 *
 * До этого бронь становилась «завершённой» только кнопкой оператора, и от неё
 * зависело всё, что бывает после тура: отзыв (сервер принимает его только по
 * завершённой брони), просьба об отзыве в Telegram, баллы. Оператор не нажал —
 * не было ничего.
 *
 * Что утверждает автомат: дата тура прошла, бронь была подтверждена, и
 * оператор не отметил ни отмены, ни неявки. Не «турист точно был» — это знает
 * только оператор, и его отметка «не явился» по-прежнему главнее: она ставится
 * из подтверждённой брони, а завершённую и «не явился» автомат не трогает. В
 * журнал броней переход пишется без исполнителя-человека и с этой причиной
 * словами.
 *
 * Последний день тура — end_date брони; нет его — дата брони плюс
 * длительность брони или тура (duration_days, multi_day_count) минус один
 * день; нет и их — сама дата брони. «Следующий день» — по Камчатке: там идёт
 * тур.
 *
 * Завершение — тем же путём, что у кнопки «Завершить»: completeBooking
 * (переход по ALLOWED_TRANSITIONS под FOR UPDATE, журнал, событие CRM) и
 * awardCompletionLoyalty. Отказ одной брони не останавливает остальные и
 * называется в ответе.
 *
 * Сторож: tests/unit/booking-auto-complete.test.ts.
 */

import { pool } from '@/lib/db-pool';
import { completeBooking } from '@/lib/bookings/booking.service';
import { awardCompletionLoyalty } from '@/lib/bookings/completion-loyalty';
import { logText } from '@/lib/log/log-text';
import { TOUR_LAST_DAY_SQL } from '@/lib/bookings/tour-last-day';

export const AUTO_COMPLETE_COMMENT =
  'Тур завершён автоматически: дата тура прошла, оператор не отметил отмену или неявку';

/** За один прогон — не больше; остаток доберёт следующий. */
export const AUTO_COMPLETE_BATCH = 200;

export { TOUR_LAST_DAY_SQL };

export const DUE_BOOKINGS_SQL = `
  SELECT ob.id::text AS id
    FROM operator_bookings ob
    JOIN operator_tours ot ON ot.id = ob.operator_tour_id
   WHERE ob.booking_status = 'confirmed'
     AND ob.deleted_at IS NULL
     AND ${TOUR_LAST_DAY_SQL} < (NOW() AT TIME ZONE 'Asia/Kamchatka')::date
   ORDER BY ob.booking_date, ob.id
   LIMIT $1`;

export interface AutoCompleteSummary {
  /** Сколько броней подошло под правило в этот прогон. */
  due: number;
  completed: string[];
  failed: Array<{ id: string; error: string }>;
}

/** Кого завершил бы прогон — тот же отбор, без завершения (сухой прогон крона). */
export async function listDueBookings(): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(DUE_BOOKINGS_SQL, [AUTO_COMPLETE_BATCH]);
  return rows.map((r) => r.id);
}

export async function autoCompletePastTours(): Promise<AutoCompleteSummary> {
  const ids = await listDueBookings();
  const summary: AutoCompleteSummary = { due: ids.length, completed: [], failed: [] };
  for (const id of ids) {
    try {
      const booking = await completeBooking(id, null, { comment: AUTO_COMPLETE_COMMENT });
      awardCompletionLoyalty(booking, id);
      summary.completed.push(id);
    } catch (err) {
      const message = logText(err instanceof Error ? err.message : err, 200);
      console.error('[booking-auto-complete] бронь не завершена:', id, message);
      summary.failed.push({ id, error: message });
    }
  }
  return summary;
}
