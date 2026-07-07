import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireAuth } from '@/lib/auth/middleware';
import { getStayPartnerId } from '@/lib/auth/stay-helpers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/stay/stats - Статистика владельца жилья.
 * Выручка честно из payment_status='paid'; ожидаемая — активные неоплаченные брони.
 */
export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAuth(request);
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
        COALESCE(SUM(b.total_price) FILTER (WHERE b.payment_status = 'paid' AND b.status <> 'cancelled'), 0) AS paid_revenue,
        COALESCE(SUM(b.total_price) FILTER (WHERE b.payment_status = 'pending' AND b.status IN ('pending', 'confirmed')), 0) AS expected_revenue,
        COUNT(b.id) FILTER (WHERE b.status = 'confirmed' AND b.check_in_date >= CURRENT_DATE) AS upcoming_checkins
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
        revenue: {
          paid: Number(row.paid_revenue ?? 0),
          expected: Number(row.expected_revenue ?? 0),
        },
      }
    } as ApiResponse<unknown>);

  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Ошибка при получении статистики' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
