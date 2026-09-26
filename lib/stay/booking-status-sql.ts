/**
 * lib/stay/booking-status-sql.ts — запрос смены статуса брони жилья.
 *
 * Вынесен из роута, потому что его копия живёт в реестре PREPARE-проверки
 * (`app/api/cron/sql-shape-check/route.ts`), а route.ts в Next.js не может
 * экспортировать ничего, кроме обработчиков.
 */

/**
 * Обновление статуса. Параметр $1 употреблён дважды — в `status = ...` и в
 * `CASE WHEN ... = 'cancelled'`. Без явного приведения node-pg шлёт его
 * без типа, и сервер выводит varchar (колонка) против text (литерал):
 * 42P08 на КАЖДОМ вызове — до 26.09 владелец не мог ни подтвердить, ни
 * отменить ни одной брони. Копия запроса — в реестре PREPARE-проверки
 * (`app/api/cron/sql-shape-check/route.ts`).
 */
export const UPDATE_STAY_BOOKING_STATUS_SQL = `UPDATE accommodation_bookings
         SET status = $1::varchar,
             cancelled_at = CASE WHEN $1::varchar = 'cancelled' THEN NOW() ELSE cancelled_at END,
             cancellation_reason = CASE WHEN $1::varchar = 'cancelled' THEN $6 ELSE cancellation_reason END,
             refund_amount = COALESCE($3, refund_amount),
             refund_percent = COALESCE($4, refund_percent),
             refund_reason = COALESCE($5, refund_reason),
             updated_at = NOW()
         WHERE id = $2 RETURNING *`;

