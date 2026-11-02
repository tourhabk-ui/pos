import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireAdmin } from '@/lib/auth/middleware';
import { BookingAdminRow, CountRow } from '@/lib/types/db-rows';
import { bookingContact } from '@/lib/admin/booking-contact';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const adminOrResponse = await requireAdmin(request);
    if (adminOrResponse instanceof NextResponse) return adminOrResponse;

    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '20');
    const offset = (page - 1) * limit;
    const status = searchParams.get('status');
    const search = searchParams.get('search');

    // Мягко удалённые брони в админ-листинге не показываем.
    const conditions: string[] = ['b.deleted_at IS NULL'];
    const params: (string | number)[] = [];
    let paramIndex = 1;

    if (status && status !== 'all') {
      conditions.push(`b.booking_status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }

    if (search) {
      conditions.push(`(u.name ILIKE $${paramIndex} OR u.email ILIKE $${paramIndex} OR b.tourist_name ILIKE $${paramIndex} OR b.tourist_email ILIKE $${paramIndex} OR t.title ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const countResult = await query<CountRow>(
      `SELECT COUNT(*) as count
       FROM operator_bookings b
       LEFT JOIN operator_tours t ON t.id = b.operator_tour_id
       LEFT JOIN users u ON u.id = COALESCE(b.user_id, (b.metadata->>'user_id')::uuid)
       ${whereClause}`,
      params
    );

    const bookingsResult = await query<BookingAdminRow>(
      `SELECT
         b.id,
         to_char(b.booking_date, 'YYYY-MM-DD') AS booking_day,
         b.participants,
         b.base_total_price,
         b.final_price,
         COALESCE(b.final_price, b.base_total_price) AS total_price,
         b.booking_status,
         b.payment_status,
         b.special_requests,
         -- created_at — timestamp без пояса в поясе сессии БД; переводим в UTC явно.
         to_char((b.created_at AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at_utc,
         b.updated_at,
         COALESCE(t.title, 'Тур удалён') AS tour_name,
         u.name AS user_name,
         u.email AS user_email,
         b.tourist_name,
         b.tourist_email,
         b.tourist_phone
       FROM operator_bookings b
       LEFT JOIN operator_tours t ON t.id = b.operator_tour_id
       LEFT JOIN users u ON u.id = COALESCE(b.user_id, (b.metadata->>'user_id')::uuid)
       ${whereClause}
       ORDER BY b.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    );

    return NextResponse.json({
      success: true,
      data: {
        bookings: bookingsResult.rows.map(b => {
          const c = bookingContact(b);
          return {
          id: b.id,
          date: b.booking_day,
          participants: b.participants,
          totalPrice: parseFloat(b.total_price),
          status: b.booking_status,
          paymentStatus: b.payment_status,
          specialRequests: b.special_requests,
          createdAt: b.created_at_utc,
          updatedAt: b.updated_at,
          tourName: b.tour_name,
          userName: c.name,
          userEmail: c.email,
          userPhoneMasked: c.phoneMasked,
          hasAccount: c.hasAccount,
          };
        }),
        pagination: {
          page,
          limit,
          total: parseInt(countResult.rows[0].count),
          totalPages: Math.ceil(parseInt(countResult.rows[0].count) / limit),
        },
      },
    } as ApiResponse<unknown>);
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Ошибка при получении бронирований' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
