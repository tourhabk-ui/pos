/**
 * GET /api/cron/test-booking-cancel?id=<id>[&apply=1] — отмена НАШЕЙ тестовой
 * брони тура. Bearer CRON_SECRET. Без apply=1 — только показывает, что
 * сделала бы (dry-run).
 *
 * Повод (02.11): тестовая бронь #6 («ТЕСТ Кузьмич», тур 36) висела в списке
 * владельца как живая заявка. Владелец велел отменить, не удаляя, и туристу
 * не писать (контакт тестовый). Админ-кнопки у раннера нет (JWT), поэтому —
 * узкая дверь с жёстким фильтром: отменяется ТОЛЬКО бронь, у которой имя
 * туриста начинается с «ТЕСТ», она не удалена, не оплачена и ещё не отменена.
 * Уведомления не уходят. Места возвращаются той же функцией, что у отмены
 * владельцем (releaseSlotsForCancelledBooking), в той же транзакции.
 * ПД в ответе нет — только id, статусы и флаги.
 */
import { NextRequest, NextResponse } from 'next/server';
import { transaction } from '@/lib/database';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { releaseSlotsForCancelledBooking } from '@/lib/payments/slot-counter';
import { isTestTouristName } from '@/lib/bookings/test-booking';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const rawId = req.nextUrl.searchParams.get('id') ?? '';
  if (!/^\d{1,18}$/.test(rawId)) {
    return NextResponse.json({ ok: false, error: 'id обязателен (число)' }, { status: 400 });
  }
  const apply = req.nextUrl.searchParams.get('apply') === '1';

  const result = await transaction(async (client) => {
    const r = await client.query<{
      id: string; booking_status: string; payment_status: string | null;
      tourist_name: string | null; deleted: boolean;
    }>(
      `SELECT id::text, booking_status, payment_status, tourist_name,
              (deleted_at IS NOT NULL) AS deleted
         FROM operator_bookings WHERE id = $1 FOR UPDATE`,
      [rawId],
    );
    const b = r.rows[0];
    if (!b) return { ok: false, reason: 'not_found' };
    const flags = { id: b.id, status_before: b.booking_status, payment_status: b.payment_status, deleted: b.deleted, test_name: isTestTouristName(b.tourist_name) };
    if (!flags.test_name) return { ok: false, reason: 'not_a_test_booking', ...flags };
    if (b.deleted) return { ok: false, reason: 'deleted', ...flags };
    if (b.payment_status === 'paid') return { ok: false, reason: 'paid_needs_human', ...flags };
    if (b.booking_status === 'cancelled') return { ok: true, reason: 'already_cancelled', ...flags };
    if (!apply) return { ok: true, reason: 'dry_run', would: 'cancelled', ...flags };

    await client.query(
      `UPDATE operator_bookings
          SET booking_status = 'cancelled', cancelled_at = NOW(), updated_at = NOW(),
              cancellation_reason = 'Тестовая бронь платформы — отменена по решению владельца'
        WHERE id = $1`,
      [rawId],
    );
    const released = await releaseSlotsForCancelledBooking(client, rawId);
    const after = await client.query<{ booking_status: string }>(
      `SELECT booking_status FROM operator_bookings WHERE id = $1`, [rawId]);
    return { ok: true, reason: 'cancelled', ...flags, status_after: after.rows[0]?.booking_status, slots_released_rows: released, notified: false };
  });

  return NextResponse.json({ probe: 'test_booking_cancel_v1', apply, ...result });
}
