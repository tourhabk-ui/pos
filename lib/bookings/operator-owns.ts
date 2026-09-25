/**
 * Владеет ли оператор бронью — туром, на который она сделана.
 *
 * До 25.09 `PATCH /api/bookings/[id]/confirm` проверял владение только
 * комментарием («здесь оператор должен владеть туром»), а `/complete` — не
 * проверял вовсе: любой оператор подтверждал чужую бронь, открывая туристу
 * оплату и отправляя ему письмо «подтверждено». Правило то же, что у отмены
 * (`/api/bookings/[id]/cancel`): бронь → тур → партнёр → user_id.
 *
 * Три исхода (§4.0): `unknown` — спросить не смогли; это не «нет доступа»,
 * вызывающий отвечает 503 и пишет причину в лог.
 */
import { pool } from '@/lib/db-pool';

export type OperatorOwnership = 'ok' | 'denied' | 'unknown';

export async function operatorOwnsBooking(bookingId: string, userId: string): Promise<OperatorOwnership> {
  if (!/^\d+$/.test(bookingId)) return 'denied';
  try {
    const { rows } = await pool.query(
      `SELECT 1
         FROM operator_bookings b
         JOIN operator_tours t ON b.operator_tour_id = t.id
         JOIN partners p ON t.operator_id = p.id
        WHERE b.id = $1::bigint AND p.user_id = $2
          AND b.deleted_at IS NULL AND t.deleted_at IS NULL
        LIMIT 1`,
      [bookingId, userId],
    );
    return rows.length > 0 ? 'ok' : 'denied';
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[bookings] operatorOwnsBooking отказ:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(err));
    return 'unknown';
  }
}
