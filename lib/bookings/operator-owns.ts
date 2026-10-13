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
 *
 * С CRM 2г (миграция 1223) бронью «владеет» кабинет, а не человек: и владелец
 * кабинета, и менеджер его команды. Кабинет решает operatorAccess; отменять
 * бронь менеджеру можно только по праву can_cancel_bookings — это проверяет
 * роут отмены, а не этот резолвер.
 */
import { pool } from '@/lib/db-pool';
import { operatorAccess } from '@/lib/operators/team-access';

export type OperatorOwnership = 'ok' | 'denied' | 'unknown';

export async function operatorOwnsBooking(bookingId: string, userId: string): Promise<OperatorOwnership> {
  if (!/^\d+$/.test(bookingId)) return 'denied';
  const access = await operatorAccess(userId);
  if (access.kind === 'unavailable') return 'unknown';
  if (access.kind === 'none') return 'denied';
  try {
    const { rows } = await pool.query(
      `SELECT 1
         FROM operator_bookings b
         JOIN operator_tours t ON b.operator_tour_id = t.id
        WHERE b.id = $1::bigint AND t.operator_id = $2::uuid
          AND b.deleted_at IS NULL AND t.deleted_at IS NULL
        LIMIT 1`,
      [bookingId, access.partnerId],
    );
    return rows.length > 0 ? 'ok' : 'denied';
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[bookings] operatorOwnsBooking отказ:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(err));
    return 'unknown';
  }
}
