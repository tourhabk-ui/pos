import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireAuth } from '@/lib/auth/middleware';
import { getStayPartnerId } from '@/lib/auth/stay-helpers';

export const dynamic = 'force-dynamic';

const ALLOWED_STATUSES = new Set(['pending', 'confirmed', 'cancelled', 'completed', 'no_show']);

/**
 * GET /api/stay/bookings - Входящие брони по объектам владельца жилья
 * Query: ?status= (pending/confirmed/cancelled/completed/no_show), ?accommodationId=, ?limit=
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

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const accommodationId = searchParams.get('accommodationId');
    const parsedLimit = Number.parseInt(searchParams.get('limit') || '50', 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 50;

    if (status && !ALLOWED_STATUSES.has(status)) {
      return NextResponse.json(
        { success: false, error: 'Некорректный статус' } as ApiResponse<null>,
        { status: 400 }
      );
    }

    // Владелец видит только брони своих объектов (scope по partner_id)
    let queryText = `
      SELECT
        b.id, b.accommodation_id, b.room_id,
        b.check_in_date, b.check_out_date, b.nights,
        b.adults, b.children,
        b.room_price_per_night, b.total_price, b.currency,
        b.status, b.payment_status,
        b.refund_amount, b.refund_percent,
        b.special_requests, b.guest_notes, b.created_at,
        a.name AS accommodation_name,
        r.name AS room_name,
        u.name AS guest_name,
        u.email AS guest_email
      FROM accommodation_bookings b
      JOIN accommodations a ON b.accommodation_id = a.id
      LEFT JOIN accommodation_rooms r ON b.room_id = r.id
      LEFT JOIN users u ON b.user_id = u.id
      WHERE a.partner_id = $1
    `;
    const params: (string | number)[] = [partnerId];

    if (status) {
      queryText += ` AND b.status = $${params.length + 1}`;
      params.push(status);
    }
    if (accommodationId) {
      queryText += ` AND b.accommodation_id = $${params.length + 1}`;
      params.push(accommodationId);
    }

    queryText += ` ORDER BY b.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await query(queryText, params);

    return NextResponse.json({
      success: true,
      data: { bookings: result.rows, count: result.rows.length }
    } as ApiResponse<unknown>);

  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Ошибка при получении броней' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
