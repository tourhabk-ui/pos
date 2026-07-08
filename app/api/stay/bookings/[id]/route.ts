import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { transaction } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireAuth } from '@/lib/auth/middleware';
import { getStayPartnerId } from '@/lib/auth/stay-helpers';
import { calculateStayRefund } from '@/lib/stay/refund-policy';
import { notifyStayBookingCancelled } from '@/lib/notifications/stay-booking';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid('Некорректный ID брони') });

const UpdateBookingStatusSchema = z.object({
  status: z.enum(['confirmed', 'cancelled', 'completed', 'no_show'], {
    errorMap: () => ({ message: 'Некорректный статус' }),
  }),
});

// Жизненный цикл брони жилья: заявка → подтверждение → заезд состоялся / no-show.
// completed, cancelled и no_show — терминальные.
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['completed', 'no_show', 'cancelled'],
  completed: [],
  cancelled: [],
  no_show: [],
};

/**
 * PATCH /api/stay/bookings/[id] - Смена статуса брони (владелец объекта или admin)
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await requireAuth(request);
    if (authResult instanceof NextResponse) return authResult;
    const userId = authResult.userId;
    const isAdmin = authResult.role === 'admin';

    const parsedParams = paramsSchema.safeParse(await params);
    if (!parsedParams.success) {
      return NextResponse.json(
        { success: false, error: 'Некорректный ID брони' } as ApiResponse<null>,
        { status: 400 }
      );
    }
    const bookingId = parsedParams.data.id;

    const partnerId = isAdmin ? null : await getStayPartnerId(userId);
    if (!isAdmin && !partnerId) {
      return NextResponse.json(
        { success: false, error: 'Профиль владельца жилья не найден' } as ApiResponse<null>,
        { status: 404 }
      );
    }

    const body = await request.json();
    const parsed = UpdateBookingStatusSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message || 'Некорректные данные' } as ApiResponse<null>,
        { status: 400 }
      );
    }
    const nextStatus = parsed.data.status;

    const outcome = await transaction(async (client) => {
      // Ownership через JOIN accommodations.partner_id — чужая бронь невидима (404)
      const bookingResult = await client.query(
        `SELECT b.id, b.status, b.payment_status, b.total_price,
                b.check_in_date::text AS check_in_date,
                b.check_out_date::text AS check_out_date,
                a.name AS accommodation_name,
                p.telegram_chat_id AS owner_chat
         FROM accommodation_bookings b
         JOIN accommodations a ON b.accommodation_id = a.id
         LEFT JOIN partners p ON a.partner_id = p.id
         WHERE b.id = $1 ${isAdmin ? '' : 'AND a.partner_id = $2'}
         FOR UPDATE OF b`,
        isAdmin ? [bookingId] : [bookingId, partnerId]
      );

      if (bookingResult.rows.length === 0) {
        return { code: 404 as const };
      }

      const booking = bookingResult.rows[0] as {
        id: string; status: string; payment_status: string; total_price: string | null;
        check_in_date: string; check_out_date: string;
        accommodation_name: string; owner_chat: string | null;
      };

      const allowed = ALLOWED_TRANSITIONS[booking.status] ?? [];
      if (!allowed.includes(nextStatus)) {
        return { code: 422 as const, currentStatus: booking.status };
      }

      // Отмена владельцем/админом оплаченной брони → полный возврат (офлайн).
      const isCancel = nextStatus === 'cancelled';
      const wasPaid = booking.payment_status === 'paid';
      const refund = isCancel && wasPaid
        ? calculateStayRefund(Number(booking.total_price ?? 0), new Date(booking.check_in_date), true)
        : null;
      const nextPaymentStatus = refund && refund.amount > 0
        ? (refund.percent >= 100 ? 'refunded' : 'partially_refunded')
        : null;

      const updated = await client.query(
        `UPDATE accommodation_bookings
         SET status = $1,
             cancelled_at = CASE WHEN $1 = 'cancelled' THEN NOW() ELSE cancelled_at END,
             refund_amount = COALESCE($3, refund_amount),
             refund_percent = COALESCE($4, refund_percent),
             refund_reason = COALESCE($5, refund_reason),
             payment_status = COALESCE($6, payment_status),
             updated_at = NOW()
         WHERE id = $2 RETURNING *`,
        [
          nextStatus, bookingId,
          refund ? refund.amount : null,
          refund ? refund.percent : null,
          refund ? refund.reason : null,
          nextPaymentStatus,
        ]
      );

      return {
        code: 200 as const,
        booking: updated.rows[0],
        notify: isCancel
          ? {
              accommodationName: booking.accommodation_name,
              checkInDate: booking.check_in_date,
              checkOutDate: booking.check_out_date,
              ownerChat: booking.owner_chat,
              wasPaid,
              refundAmount: refund ? refund.amount : null,
              refundPercent: refund ? refund.percent : null,
            }
          : null,
      };
    });

    if (outcome.code === 404) {
      return NextResponse.json(
        { success: false, error: 'Бронь не найдена' } as ApiResponse<null>,
        { status: 404 }
      );
    }

    if (outcome.code === 422) {
      return NextResponse.json(
        {
          success: false,
          error: `Переход из статуса «${outcome.currentStatus}» в «${nextStatus}» невозможен`
        } as ApiResponse<null>,
        { status: 422 }
      );
    }

    // Отмена → уведомляем владельца/админа о сумме возврата (офлайн). Non-fatal.
    if (outcome.notify) {
      try {
        await notifyStayBookingCancelled({
          bookingId,
          accommodationName: outcome.notify.accommodationName,
          checkInDate: outcome.notify.checkInDate,
          checkOutDate: outcome.notify.checkOutDate,
          ownerTelegramChatId: outcome.notify.ownerChat,
          byOwner: true,
          wasPaid: outcome.notify.wasPaid,
          refundAmount: outcome.notify.refundAmount,
          refundPercent: outcome.notify.refundPercent,
        });
      } catch {
        // уведомление не критично
      }
    }

    return NextResponse.json({
      success: true,
      data: outcome.booking,
      message: 'Статус брони обновлён'
    } as ApiResponse<unknown>);

  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Ошибка при обновлении статуса брони' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
