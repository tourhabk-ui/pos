/**
 * lib/bookings/auto-confirm.ts — автоподтверждение брони по выбору оператора.
 *
 * ── Решение владельца 04.10 ────────────────────────────────────────────────
 *
 * «Мгновенная оплата — да, по желанию оператора». Правило 24.09 не ломается, а
 * расширяется: оплата открывается после подтверждения; подтверждение бывает
 * ручным или автоматическим — по выбору оператора. Оператор, включивший
 * настройку, берёт на себя ответственность за то, что его расписание и места
 * актуальны.
 *
 * ── Когда бронь подтверждается сама ────────────────────────────────────────
 *
 * Все три условия сразу:
 *   1. оператор включил `operator_settings.auto_confirm_bookings` (строка
 *      настроек привязана к аккаунту оператора, partners.user_id);
 *   2. на дату брони у тура есть строка расписания (`tour_availability`,
 *      не отменена, не удалена) — дата, которую оператор сам выложил.
 *      Дата, введённая туристом руками мимо календаря, автоматом не
 *      подтверждается никогда;
 *   3. места на неё есть — это проверил `reserveBooking` в транзакции брони,
 *      иначе брони бы не было.
 *
 * «Не смог проверить» (база не ответила) — НЕ подтверждение: бронь остаётся
 * `new`, оператор подтвердит руками, отказ — в лог (§4.0).
 */
import { query } from '@/lib/database';
import { confirmBooking } from '@/lib/bookings/booking.service';

export const AUTO_CONFIRM_COMMENT =
  'Подтверждено автоматически: оператор включил автоподтверждение, дата есть в его расписании, места есть';

/** true — подтверждать; false — нет; null — не смог проверить (значит, нет). */
export async function autoConfirmAllowed(tourId: number, date: string): Promise<boolean | null> {
  try {
    const { rows } = await query<{ allowed: boolean }>(
      `SELECT (COALESCE(os.auto_confirm_bookings, false)
               AND EXISTS (
                 SELECT 1 FROM tour_availability ta
                  WHERE ta.operator_tour_id = ot.id
                    AND ta.date = $2::date
                    AND ta.is_cancelled = false
                    AND ta.deleted_at IS NULL
               )) AS allowed
         FROM operator_tours ot
         JOIN partners p ON p.id = ot.operator_id
         LEFT JOIN operator_settings os ON os.user_id = p.user_id
        WHERE ot.id = $1`,
      [tourId, date],
    );
    return rows[0]?.allowed === true;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[auto-confirm] настройка оператора не прочитана — бронь остаётся на ручном подтверждении:',
      `tour=${tourId}`, `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(err));
    return null;
  }
}

/**
 * Подтвердить свежую бронь, если оператор так решил. Возвращает статус, в
 * котором бронь осталась: 'confirmed' — подтверждена сейчас, 'new' — ждёт
 * оператора (настройка выключена, даты нет в расписании или не смогли).
 */
export async function autoConfirmIfAllowed(
  bookingId: number | string,
  tourId: number,
  date: string,
): Promise<'confirmed' | 'new'> {
  const allowed = await autoConfirmAllowed(tourId, date);
  if (allowed !== true) return 'new';
  try {
    await confirmBooking(String(bookingId), null, AUTO_CONFIRM_COMMENT);
    return 'confirmed';
  } catch (err) {
    console.error('[auto-confirm] автоподтверждение не прошло — бронь ждёт оператора:',
      `booking=${bookingId}`, err instanceof Error ? err.message : String(err));
    return 'new';
  }
}
