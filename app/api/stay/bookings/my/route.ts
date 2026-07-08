import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { requireAuth } from '@/lib/auth/middleware';

export const dynamic = 'force-dynamic';

/**
 * GET /api/stay/bookings/my — брони жилья текущего гостя.
 * Скоуп строго по user_id (не по partner — это владельческий
 * /api/stay/bookings). Джойнит объект (название, адрес, первое фото)
 * и номер для карточки в ЛК туриста.
 */
export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;

  try {
    const { rows } = await pool.query(
      `SELECT
         b.id, b.status, b.payment_status,
         b.check_in_date::text AS check_in_date,
         b.check_out_date::text AS check_out_date,
         b.nights, b.adults, b.children, b.total_price, b.currency,
         b.created_at,
         a.id AS accommodation_id, a.name AS accommodation_name, a.address,
         r.name AS room_name,
         (SELECT ast.url FROM accommodation_assets aa
          JOIN assets ast ON aa.asset_id = ast.id
          WHERE aa.accommodation_id = a.id
          ORDER BY ast.created_at ASC LIMIT 1) AS image_url,
         (b.check_in_date > CURRENT_DATE
          AND b.status IN ('pending', 'confirmed')) AS cancellable
       FROM accommodation_bookings b
       JOIN accommodations a ON b.accommodation_id = a.id
       LEFT JOIN accommodation_rooms r ON b.room_id = r.id
       WHERE b.user_id = $1
       ORDER BY b.check_in_date DESC`,
      [authResult.userId]
    );

    return NextResponse.json({
      success: true,
      data: {
        bookings: rows.map(r => ({
          id: r.id,
          status: r.status,
          paymentStatus: r.payment_status,
          checkInDate: r.check_in_date,
          checkOutDate: r.check_out_date,
          nights: r.nights,
          adults: r.adults,
          children: r.children,
          totalPrice: r.total_price != null ? Number(r.total_price) : null,
          currency: r.currency,
          accommodationId: r.accommodation_id,
          accommodationName: r.accommodation_name,
          address: r.address,
          roomName: r.room_name,
          imageUrl: r.image_url,
          cancellable: r.cancellable,
          createdAt: r.created_at,
        })),
      },
    });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Ошибка при получении броней' },
      { status: 500 }
    );
  }
}
