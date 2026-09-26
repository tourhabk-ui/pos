import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { transaction } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireAuth } from '@/lib/auth/middleware';
import { getStayPartnerId } from '@/lib/auth/stay-helpers';
import { calculateStayRefund } from '@/lib/stay/refund-policy';
import {
  notifyStayBookingCancelled,
  notifyStayGuestStatus,
  logStayFailure,
} from '@/lib/notifications/stay-booking';
import {
  roomNightsSql,
  firstUnsellableNight,
  KAMCHATKA_TODAY_SQL,
  type RoomNightRow,
} from '@/lib/stay/availability';
import { UPDATE_STAY_BOOKING_STATUS_SQL } from '@/lib/stay/booking-status-sql';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid('Некорректный ID брони') });

const UpdateBookingStatusSchema = z.union([
  z.object({
    status: z.enum(['confirmed', 'cancelled', 'completed', 'no_show'], {
      message: 'Некорректный статус',
    }),
    /** Причина отмены — уходит гостю (экранируется в письме и Telegram). */
    reason: z.string().trim().max(500, 'Причина — не длиннее 500 символов').optional(),
  }),
  // «Деньги гостю возвращены» — только для броней, оплаченных ЧЕРЕЗ ПЛАТФОРМУ
  // (старые, до оплаты на месте 26.09), и только администрацией: деньги
  // лежат у платформы, у владельца их нет (§7). Владелец этот флаг не ставит.
  z.object({ refund_done: z.literal(true) }),
]);

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
 * «Заезд состоялся» и «гость не заехал» — факты дня заезда. Отметить их
 * заранее значит соврать: будущую бронь владелец мог закрыть неявкой и
 * освободить номер, пока гость ещё едет. День — камчатский (сервер в UTC).
 */
const NEEDS_CHECKIN_REACHED = new Set(['completed', 'no_show']);

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

    let body: unknown;
    try { body = await request.json(); } catch {
      return NextResponse.json(
        { success: false, error: 'Некорректный JSON' } as ApiResponse<null>,
        { status: 400 }
      );
    }
    const parsed = UpdateBookingStatusSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message || 'Некорректные данные' } as ApiResponse<null>,
        { status: 400 }
      );
    }

    if ('refund_done' in parsed.data) {
      // Владельцу — нет: при оплате на месте платформа денег не принимала, а
      // по старой оплате через платформу деньги у платформы, не у него.
      if (!isAdmin) {
        return NextResponse.json(
          {
            success: false,
            error: 'Возврат по брони, оплаченной через платформу, оформляет и отмечает администрация платформы. При оплате на месте возвращать нечего.',
          } as ApiResponse<null>,
          { status: 403 }
        );
      }
      const marked = await transaction(async (client) => {
        const r = await client.query(
          `UPDATE accommodation_bookings b
              SET payment_status = 'refunded', updated_at = NOW()
            WHERE b.id = $1
              AND b.status = 'cancelled' AND b.payment_status = 'paid'
              AND COALESCE(b.refund_amount, 0) > 0
            RETURNING b.id`,
          [bookingId],
        );
        return r.rowCount ?? 0;
      });
      if (marked === 0) {
        return NextResponse.json(
          { success: false, error: 'Отметить возврат можно только у отменённой оплаченной брони с суммой к возврату' } as ApiResponse<null>,
          { status: 422 }
        );
      }
      return NextResponse.json({ success: true, message: 'Возврат отмечен' } as ApiResponse<null>);
    }

    const partnerId = isAdmin ? null : await getStayPartnerId(userId);
    if (!isAdmin && !partnerId) {
      return NextResponse.json(
        { success: false, error: 'Профиль владельца жилья не найден' } as ApiResponse<null>,
        { status: 404 }
      );
    }

    const nextStatus = parsed.data.status;
    const reason = nextStatus === 'cancelled' && parsed.data.reason ? parsed.data.reason : null;

    const outcome = await transaction(async (client) => {
      // Ownership через JOIN accommodations.partner_id — чужая бронь невидима (404)
      const bookingResult = await client.query(
        `SELECT b.id, b.status, b.payment_status, b.total_price,
                b.user_id::text AS user_id,
                b.accommodation_id::text AS accommodation_id,
                b.room_id::text AS room_id,
                b.check_in_date::text AS check_in_date,
                b.check_out_date::text AS check_out_date,
                (b.check_in_date <= ${KAMCHATKA_TODAY_SQL}) AS checkin_reached,
                a.name AS accommodation_name,
                r.name AS room_name,
                p.telegram_chat_id AS owner_chat
         FROM accommodation_bookings b
         JOIN accommodations a ON b.accommodation_id = a.id
         LEFT JOIN accommodation_rooms r ON r.id = b.room_id
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
        user_id: string | null; accommodation_id: string; room_id: string | null;
        check_in_date: string; check_out_date: string; checkin_reached: boolean;
        accommodation_name: string; room_name: string | null; owner_chat: string | null;
      };

      const allowed = ALLOWED_TRANSITIONS[booking.status] ?? [];
      if (!allowed.includes(nextStatus)) {
        return { code: 422 as const, currentStatus: booking.status };
      }

      if (NEEDS_CHECKIN_REACHED.has(nextStatus) && !booking.checkin_reached) {
        return { code: 409 as const, error: 'Отметить заезд или неявку можно только в день заезда или позже (по времени Камчатки)' };
      }

      // Подтверждение — перепроверка занятости под той же блокировкой, что и
      // бронь (lib/stay/availability.ts). Заявка старше срока удержания
      // номер уже не держит, и его могли продать другому: подтвердить её
      // вслепую значило бы продать один номер дважды.
      if (nextStatus === 'confirmed' && booking.room_id) {
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [booking.accommodation_id]);
        const nights = await client.query<RoomNightRow>(
          roomNightsSql({
            accommodation: '$1::uuid', start: '$2::date', endExclusive: '$3::date',
            room: '$4', excludeBooking: '$5',
          }),
          [booking.accommodation_id, booking.check_in_date, booking.check_out_date, booking.room_id, bookingId]
        );
        const full = nights.rows.find(n => Number(n.free_units) < 1);
        if (full) {
          return {
            code: 409 as const,
            error: `Номер на ${full.night.split('-').reverse().join('.')} уже занят другой бронью — подтвердить заявку нельзя. Отмените её, чтобы гость узнал и выбрал другие даты.`,
          };
        }
      }

      // Отмена владельцем/админом брони, оплаченной ЧЕРЕЗ ПЛАТФОРМУ (только
      // старые брони) → полный возврат, который оформляет администрация.
      // При оплате на месте (все новые брони) денег у платформы нет — и
      // возврата нет.
      const isCancel = nextStatus === 'cancelled';
      const wasPaid = booking.payment_status === 'paid';
      const refund = isCancel && wasPaid
        ? calculateStayRefund(Number(booking.total_price ?? 0), new Date(booking.check_in_date), true)
        : null;

      const updated = await client.query(
        UPDATE_STAY_BOOKING_STATUS_SQL,
        [
          nextStatus, bookingId,
          refund ? refund.amount : null,
          refund ? refund.percent : null,
          refund ? refund.reason : null,
          reason,
        ]
      );

      return {
        code: 200 as const,
        booking: updated.rows[0],
        guest: nextStatus === 'confirmed' || isCancel
          ? {
              guestUserId: booking.user_id,
              status: nextStatus as 'confirmed' | 'cancelled',
              accommodationName: booking.accommodation_name,
              roomName: booking.room_name,
              checkInDate: booking.check_in_date,
              checkOutDate: booking.check_out_date,
              totalPrice: booking.total_price == null ? null : Number(booking.total_price),
              cancellationReason: reason,
              wasPaid,
              refundAmount: refund ? refund.amount : null,
            }
          : null,
        notify: isCancel
          ? {
              accommodationName: booking.accommodation_name,
              checkInDate: booking.check_in_date,
              checkOutDate: booking.check_out_date,
              ownerChat: booking.owner_chat,
              wasPaid,
              refundAmount: refund ? refund.amount : null,
              refundPercent: refund ? refund.percent : null,
              refundReason: refund ? refund.reason : null,
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

    if (outcome.code === 409) {
      return NextResponse.json(
        { success: false, error: outcome.error } as ApiResponse<null>,
        { status: 409 }
      );
    }

    // Гостю — о решении владельца. До 26.09 гость не узнавал ни о
    // подтверждении, ни об отмене. Non-fatal, но каждый отказ в логе.
    if (outcome.guest) {
      try {
        await notifyStayGuestStatus({ bookingId, ...outcome.guest });
      } catch (err) {
        logStayFailure('PATCH: уведомление гостю', err);
      }
    }

    // Отмена → уведомляем владельца/админа. Non-fatal.
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
          refundReason: outcome.notify.refundReason,
        });
      } catch (err) {
        logStayFailure('PATCH: уведомление об отмене владельцу/админу', err);
      }
    }

    return NextResponse.json({
      success: true,
      data: outcome.booking,
      message: 'Статус брони обновлён'
    } as ApiResponse<unknown>);

  } catch (error) {
    logStayFailure('PATCH: статус брони не обновлён', error);
    return NextResponse.json(
      { success: false, error: 'Ошибка при обновлении статуса брони' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
