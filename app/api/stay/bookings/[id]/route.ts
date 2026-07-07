import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { transaction } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireAuth } from '@/lib/auth/middleware';
import { getStayPartnerId } from '@/lib/auth/stay-helpers';

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
        `SELECT b.id, b.status
         FROM accommodation_bookings b
         JOIN accommodations a ON b.accommodation_id = a.id
         WHERE b.id = $1 ${isAdmin ? '' : 'AND a.partner_id = $2'}
         FOR UPDATE OF b`,
        isAdmin ? [bookingId] : [bookingId, partnerId]
      );

      if (bookingResult.rows.length === 0) {
        return { code: 404 as const };
      }

      const booking = bookingResult.rows[0] as { id: string; status: string };

      const allowed = ALLOWED_TRANSITIONS[booking.status] ?? [];
      if (!allowed.includes(nextStatus)) {
        return { code: 422 as const, currentStatus: booking.status };
      }

      const updated = await client.query(
        `UPDATE accommodation_bookings SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [nextStatus, bookingId]
      );

      return { code: 200 as const, booking: updated.rows[0] };
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
