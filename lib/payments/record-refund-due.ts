/**
 * Записать, сколько вернуть туристу, — в той же транзакции, что и отмена.
 *
 * Зовут обе двери отмены тура: ветка `op-` в /api/bookings/[id]/cancel и
 * `cancelBooking` (lib/bookings/booking.service.ts), через который идут
 * кабинет туриста, оператор из Telegram и прочие. Считает единое правило
 * `computeTourRefund` (lib/payments/tour-refund.ts) по условиям тура и
 * пишет итог в `tour_payments.refund_due` — оттуда его берёт администратор,
 * отмечая возврат (/api/admin/finance/refunds).
 *
 * Возврат считается только от оплаты в HELD: PENDING ещё не подтверждён
 * платёжной системой, RELEASED уже ушёл оператору. Нет такой оплаты —
 * `null`: «оплаты не было», а не «вернуть ноль» — ноль читался бы как отказ
 * в возврате оплаченного.
 */
import type { PoolClient } from 'pg';
import { computeTourRefund, type TourRefund } from '@/lib/payments/tour-refund';

type Queryable = Pick<PoolClient, 'query'>;

export async function recordRefundDue(
  client: Queryable,
  bookingId: string | number,
  byOperator: boolean,
): Promise<TourRefund | null> {
  const { rows } = await client.query<{
    payment_id: string;
    retail_amount: string;
    tour_date: string;
    cancelled_at: Date | null;
    free_days: number | null;
    late_percent: number | null;
  }>(
    `SELECT tp.id AS payment_id,
            tp.retail_amount,
            ob.booking_date::text AS tour_date,
            ob.cancelled_at,
            ot.cancellation_free_days AS free_days,
            ot.cancellation_late_refund_percent AS late_percent
       FROM tour_payments tp
       JOIN operator_bookings ob ON ob.id = tp.booking_id
       LEFT JOIN operator_tours ot ON ot.id = ob.operator_tour_id
      WHERE tp.booking_id = $1::bigint
        AND tp.status = 'HELD'
      ORDER BY tp.created_at DESC
      LIMIT 1
      FOR UPDATE OF tp`,
    [bookingId],
  );
  const row = rows[0];
  if (!row) return null;

  const refund = computeTourRefund({
    paidAmount: Number(row.retail_amount),
    tourDate: row.tour_date,
    cancelledAt: row.cancelled_at ?? new Date(),
    terms: { freeDays: row.free_days, lateRefundPercent: row.late_percent },
    byOperator,
  });

  await client.query(
    `UPDATE tour_payments
        SET refund_due = $2, refund_due_reason = $3, updated_at = NOW()
      WHERE id = $1`,
    [row.payment_id, refund.amount, refund.reason],
  );
  return refund;
}
