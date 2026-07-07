import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireAuth } from '@/lib/auth/middleware';
import { getStayPartnerId } from '@/lib/auth/stay-helpers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/stay/accommodations - Объекты владельца жилья (включая снятые с публикации)
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
        a.id, a.name, a.type, a.description, a.short_description, a.address,
        a.location_zone, a.star_rating, a.total_rooms,
        a.check_in_time, a.check_out_time,
        a.price_per_night_from, a.price_per_night_to, a.currency,
        a.amenities, a.rating, a.review_count,
        a.is_active, a.is_verified, a.created_at, a.updated_at,
        (SELECT COUNT(*) FROM accommodation_rooms r WHERE r.accommodation_id = a.id AND r.is_active = true) AS rooms_count,
        (SELECT COUNT(*) FROM accommodation_bookings b WHERE b.accommodation_id = a.id AND b.status = 'pending') AS pending_bookings
      FROM accommodations a
      WHERE a.partner_id = $1
      ORDER BY a.created_at DESC`,
      [partnerId]
    );

    return NextResponse.json({
      success: true,
      data: { accommodations: result.rows }
    } as ApiResponse<unknown>);

  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Ошибка при получении объектов размещения' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
