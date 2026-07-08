import { NextRequest, NextResponse } from 'next/server';
import { transaction } from '@/lib/database';
import { requireAuth } from '@/lib/auth/middleware';
import { notifyStayBookingCancelled } from '@/lib/notifications/stay-booking';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid('Некорректный ID брони') });

/**
 * POST /api/stay/bookings/[id]/cancel — гость отменяет СВОЮ бронь жилья.
 * Ownership по user_id (не partner — это владельческий PATCH). Отменяемы
 * только будущие брони в статусе pending/confirmed; прошедшие и терминальные
 * — 422 (через владельца/поддержку). Владелец объекта уведомляется.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;

  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Некорректный ID брони' }, { status: 400 });
  }
  const bookingId = parsed.data.id;

  try {
    const outcome = await transaction(async (client) => {
      // Строго своя бронь; данные владельца — для уведомления
      const bookingResult = await client.query(
        `SELECT b.id, b.status,
                b.check_in_date > CURRENT_DATE AS is_future,
                b.check_in_date::text AS check_in_date,
                b.check_out_date::text AS check_out_date,
                a.name AS accommodation_name,
                p.telegram_chat_id AS owner_chat
         FROM accommodation_bookings b
         JOIN accommodations a ON b.accommodation_id = a.id
         LEFT JOIN partners p ON a.partner_id = p.id
         WHERE b.id = $1 AND b.user_id = $2
         FOR UPDATE OF b`,
        [bookingId, authResult.userId]
      );

      if (bookingResult.rows.length === 0) {
        return { code: 404 as const };
      }
      const b = bookingResult.rows[0] as {
        status: string; is_future: boolean;
        check_in_date: string; check_out_date: string;
        accommodation_name: string; owner_chat: string | null;
      };

      const cancellable = (b.status === 'pending' || b.status === 'confirmed') && b.is_future;
      if (!cancellable) {
        return { code: 422 as const, status: b.status, isFuture: b.is_future };
      }

      await client.query(
        `UPDATE accommodation_bookings SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
        [bookingId]
      );

      return {
        code: 200 as const,
        ownerChat: b.owner_chat,
        accommodationName: b.accommodation_name,
        checkInDate: b.check_in_date,
        checkOutDate: b.check_out_date,
      };
    });

    if (outcome.code === 404) {
      return NextResponse.json({ success: false, error: 'Бронь не найдена' }, { status: 404 });
    }
    if (outcome.code === 422) {
      const reason = !outcome.isFuture
        ? 'Прошедшую бронь отменяет владелец или поддержка'
        : `Бронь в статусе «${outcome.status}» отменить нельзя`;
      return NextResponse.json({ success: false, error: reason }, { status: 422 });
    }

    // Уведомляем владельца — даты снова свободны. Non-fatal.
    try {
      await notifyStayBookingCancelled({
        bookingId,
        accommodationName: outcome.accommodationName,
        checkInDate: outcome.checkInDate,
        checkOutDate: outcome.checkOutDate,
        ownerTelegramChatId: outcome.ownerChat,
      });
    } catch {
      // уведомление не критично
    }

    return NextResponse.json({ success: true, message: 'Бронь отменена' });
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка при отмене брони' }, { status: 500 });
  }
}
