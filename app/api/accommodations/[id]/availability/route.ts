import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';

export const dynamic = 'force-dynamic';

interface RoomAvailability {
  date: string;
  available: boolean;
  roomsLeft: number;
  price: number;
  reason?: string;
}

/**
 * GET /api/accommodations/[id]/availability
 * Проверка доступности номеров в отеле
 * Public by design: availability check for accommodation selection.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);
    
    // Поддерживаем оба варианта параметров
    const checkIn = searchParams.get('checkIn') || searchParams.get('startDate');
    const checkOut = searchParams.get('checkOut') || searchParams.get('endDate');

    if (!checkIn || !checkOut) {
      return NextResponse.json({
        success: false,
        error: 'Check-in and check-out dates are required'
      } as ApiResponse<null>, { status: 400 });
    }

    // Проверяем существование размещения
    const accommQuery = `
      SELECT id, name, total_rooms, price_per_night_from, is_active
      FROM accommodations
      WHERE id = $1
    `;
    const accommResult = await query<{ id: string; name: string; total_rooms: string; price_per_night_from: string; is_active: boolean }>(accommQuery, [id]);

    if (accommResult.rows.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'Accommodation not found'
      } as ApiResponse<null>, { status: 404 });
    }

    const accommodation = accommResult.rows[0];

    if (!accommodation.is_active) {
      return NextResponse.json({
        success: false,
        error: 'Accommodation is not active'
      } as ApiResponse<null>, { status: 400 });
    }

    // Доступность на каждую дату: брони + блокировки/тарифы владельца
    // из accommodation_availability (уровень объекта, room_id IS NULL)
    const availabilityQuery = `
      WITH RECURSIVE date_series AS (
        SELECT $1::date AS date
        UNION ALL
        SELECT date + 1
        FROM date_series
        WHERE date < $2::date
      ),
      booked_rooms AS (
        SELECT
          ds.date,
          COUNT(DISTINCT ab.id) as rooms_booked
        FROM date_series ds
        LEFT JOIN accommodation_bookings ab ON ab.accommodation_id = $3
          AND ab.status IN ('confirmed', 'pending')
          AND ds.date >= ab.check_in_date
          AND ds.date < ab.check_out_date
        GROUP BY ds.date
      )
      SELECT
        ds.date::text,
        COALESCE(br.rooms_booked, 0) as booked,
        $4::integer as total_rooms,
        ($4::integer - COALESCE(br.rooms_booked, 0)) as rooms_left,
        av.price_override,
        CASE
          WHEN ds.date < CURRENT_DATE THEN 'past'
          WHEN COALESCE(av.is_blocked, false) THEN 'blocked'
          WHEN COALESCE(br.rooms_booked, 0) >= $4::integer THEN 'full'
          ELSE 'available'
        END as status
      FROM date_series ds
      LEFT JOIN booked_rooms br ON br.date = ds.date
      LEFT JOIN accommodation_availability av
        ON av.accommodation_id = $3 AND av.room_id IS NULL AND av.date = ds.date
      ORDER BY ds.date
    `;

    const availResult = await query<{ date: string; booked: string; total_rooms: number; rooms_left: string; price_override: string | null; status: string }>(availabilityQuery, [
      checkIn,
      checkOut,
      id,
      accommodation.total_rooms || 10
    ]);

    const availability: RoomAvailability[] = availResult.rows.map(row => {
      const available = row.status === 'available';
      const roomsLeft = parseInt(row.rooms_left);

      let reason: string | undefined;
      if (row.status === 'past') {
        reason = 'Дата в прошлом';
      } else if (row.status === 'full') {
        reason = 'Все номера заняты';
      } else if (row.status === 'blocked') {
        reason = 'Владелец закрыл продажу на эту дату';
      }

      return {
        date: row.date,
        available,
        roomsLeft: available ? roomsLeft : 0,
        price: row.price_override != null
          ? parseFloat(row.price_override)
          : parseFloat(accommodation.price_per_night_from),
        reason
      };
    });

    // Проверяем, доступны ли ВСЕ даты
    const allAvailable = availability.every(a => a.available);

    return NextResponse.json({
      success: true,
      data: {
        accommodationId: id,
        accommodationName: accommodation.name,
        available: allAvailable,
        availability,
        totalRooms: parseInt(accommodation.total_rooms) || 10
      }
    } as ApiResponse<unknown>);

  } catch (error) {
    return NextResponse.json({
      success: false,
      error: 'Failed to check availability',
      message: error instanceof Error ? error.message : 'Unknown error'
    } as ApiResponse<null>, { status: 500 });
  }
}


