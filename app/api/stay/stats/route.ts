import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { getStayPartnerId, requireStayOwner, StayCheckUnavailableError, stayCheckUnavailableResponse } from '@/lib/auth/stay-helpers';
import { logStayFailure } from '@/lib/stay/db-failure';

export const dynamic = 'force-dynamic';

/**
 * GET /api/stay/stats - Статистика владельца жилья.
 *
 * Денег платформа не видит: жильё оплачивается владельцу на месте при
 * заселении (решение владельца 26.09). Поэтому здесь нет «оплачено» — до
 * 26.09 карточка «Оплачено» суммировала payment_status='paid', который при
 * оплате на месте не наступает никогда, и показывала владельцу вечный ноль
 * как его выручку. Вместо неё — суммы броней по их статусу, названные тем,
 * чем они являются:
 *   atCheckIn — подтверждённые брони, заезд впереди или идёт: столько гости
 *               должны заплатить вам при заселении (по цене брони);
 *   completed — брони, где вы отметили «заезд состоялся».
 */
export async function GET(request: NextRequest) {
  try {
    // Гейт по роли (как в layout кабинета), скоуп данных — по своему партнёру.
    const authResult = await requireStayOwner(request);
    if (authResult instanceof NextResponse) return authResult;
    const userId = authResult.userId;

    const partnerId = await getStayPartnerId(userId);
    if (!partnerId) {
      return NextResponse.json(
        { success: false, error: 'Профиль владельца жилья не найден' } as ApiResponse<null>,
        { status: 404 }
      );
    }

    const result = await query(
      `SELECT
        (SELECT COUNT(*) FROM accommodations WHERE partner_id = $1) AS total_accommodations,
        (SELECT COUNT(*) FROM accommodations WHERE partner_id = $1 AND is_active = true) AS active_accommodations,
        COUNT(b.id) AS total_bookings,
        COUNT(b.id) FILTER (WHERE b.status = 'pending') AS pending_bookings,
        COUNT(b.id) FILTER (WHERE b.status = 'confirmed') AS confirmed_bookings,
        COUNT(b.id) FILTER (WHERE b.status = 'completed') AS completed_bookings,
        COUNT(b.id) FILTER (WHERE b.status = 'cancelled') AS cancelled_bookings,
        COUNT(b.id) FILTER (WHERE b.status = 'no_show') AS no_show_bookings,
        COALESCE(SUM(b.total_price) FILTER (WHERE b.status = 'confirmed' AND b.check_out_date > (NOW() AT TIME ZONE 'Asia/Kamchatka')::date), 0) AS at_checkin_sum,
        COALESCE(SUM(b.total_price) FILTER (WHERE b.status = 'completed'), 0) AS completed_sum,
        COUNT(b.id) FILTER (WHERE b.status = 'confirmed' AND b.check_in_date >= (NOW() AT TIME ZONE 'Asia/Kamchatka')::date) AS upcoming_checkins
      FROM accommodation_bookings b
      JOIN accommodations a ON b.accommodation_id = a.id
      WHERE a.partner_id = $1`,
      [partnerId]
    );

    const row = result.rows[0] as Record<string, string | number>;

    return NextResponse.json({
      success: true,
      data: {
        accommodations: {
          total: Number(row.total_accommodations ?? 0),
          active: Number(row.active_accommodations ?? 0),
        },
        bookings: {
          total: Number(row.total_bookings ?? 0),
          pending: Number(row.pending_bookings ?? 0),
          confirmed: Number(row.confirmed_bookings ?? 0),
          completed: Number(row.completed_bookings ?? 0),
          cancelled: Number(row.cancelled_bookings ?? 0),
          noShow: Number(row.no_show_bookings ?? 0),
          upcomingCheckins: Number(row.upcoming_checkins ?? 0),
        },
        // Суммы броней, а не деньги: оплату на месте платформа не видит.
        bookingSums: {
          atCheckIn: Number(row.at_checkin_sum ?? 0),
          completed: Number(row.completed_sum ?? 0),
        },
      }
    } as ApiResponse<unknown>);

  } catch (error) {
    if (error instanceof StayCheckUnavailableError) return stayCheckUnavailableResponse();
    logStayFailure('GET /api/stay/stats', error);
    return NextResponse.json(
      { success: false, error: 'Ошибка при получении статистики' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
