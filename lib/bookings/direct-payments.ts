/**
 * Оплата напрямую оператору (CRM фаза 2в, миграция 1215).
 *
 * Решение владельца 11.10: отметка ОТДЕЛЬНАЯ от оплаты через платформу.
 * Здесь нет и не должно быть записи в `operator_bookings.paid_at`,
 * `payment_status`, `tour_payments` и `operator_commissions`: те значат
 * «деньги прошли через платформу» и запускают комиссию и выплату (§7). Деньги,
 * полученные оператором наличными или переводом, через платформу не шли.
 *
 * Записей у брони несколько (предоплата, остаток). Ошибочная аннулируется с
 * причиной и остаётся в истории.
 */

import { pool } from '@/lib/db-pool';

export {
  DIRECT_PAYMENT_METHODS, DIRECT_PAYMENT_METHOD_LABELS, directPaidTotal, directRemaining,
} from '@/lib/bookings/direct-payment-kinds';
export type { DirectPaymentMethod, DirectPaymentRow } from '@/lib/bookings/direct-payment-kinds';
import type { DirectPaymentMethod, DirectPaymentRow } from '@/lib/bookings/direct-payment-kinds';

export async function listDirectPayments(bookingId: string): Promise<DirectPaymentRow[]> {
  const { rows } = await pool.query<DirectPaymentRow>(
    `SELECT id::text AS id, amount::float8 AS amount, method,
            to_char(received_on, 'YYYY-MM-DD') AS received_on, note,
            created_at::text AS created_at, voided_at::text AS voided_at, void_reason
       FROM booking_direct_payments
      WHERE booking_id = $1::bigint
      ORDER BY received_on DESC, created_at DESC`,
    [bookingId],
  );
  return rows;
}

export interface NewDirectPayment {
  bookingId: string;
  amount: number;
  method: DirectPaymentMethod;
  receivedOn: string;
  note: string | null;
  userId: string;
}

export async function addDirectPayment(p: NewDirectPayment): Promise<DirectPaymentRow> {
  const { rows } = await pool.query<DirectPaymentRow>(
    `INSERT INTO booking_direct_payments (booking_id, amount, method, received_on, note, recorded_by)
     VALUES ($1::bigint, $2, $3, $4::date, $5, $6::uuid)
     RETURNING id::text AS id, amount::float8 AS amount, method,
               to_char(received_on, 'YYYY-MM-DD') AS received_on, note,
               created_at::text AS created_at, voided_at::text AS voided_at, void_reason`,
    [p.bookingId, p.amount, p.method, p.receivedOn, p.note, p.userId],
  );
  return rows[0];
}

/**
 * Аннулировать запись этой брони. null — записи нет у этой брони или она уже
 * аннулирована (повтор не перезаписывает причину).
 */
export async function voidDirectPayment(bookingId: string, paymentId: string, reason: string, userId: string): Promise<DirectPaymentRow | null> {
  const { rows } = await pool.query<DirectPaymentRow>(
    `UPDATE booking_direct_payments
        SET voided_at = NOW(), void_reason = $3, voided_by = $4::uuid
      WHERE id = $2::uuid AND booking_id = $1::bigint AND voided_at IS NULL
      RETURNING id::text AS id, amount::float8 AS amount, method,
                to_char(received_on, 'YYYY-MM-DD') AS received_on, note,
                created_at::text AS created_at, voided_at::text AS voided_at, void_reason`,
    [bookingId, paymentId, reason, userId],
  );
  return rows[0] ?? null;
}
