import { occupiedOnDaySql } from '@/lib/bookings/occupancy';
import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { TourCheckRow, AvailabilityDateRow } from '@/lib/types/db-rows';

export const dynamic = 'force-dynamic';

interface AvailabilityDate {
  date: string;
  available: boolean;
  spotsLeft: number;
  price: number;
  reason?: string;
}

/**
 * GET /api/tours/[id]/availability
 * Проверка доступности дат для тура
 * Public by design: availability check for tour selection.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);
    
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');

    if (!startDate || !endDate) {
      return NextResponse.json({
        success: false,
        error: 'Start and end dates are required'
      } as ApiResponse<null>, { status: 400 });
    }

    // Проверяем существование тура.
    // min_participants: колонки min_group_size в operator_tours НЕТ (алиас с
    // таким именем живёт только во VIEW миграции 056) — запрос падал 42703 на
    // КАЖДОМ вызове, роут не отработал ни разу. is_published: снятый с
    // витрины тур не должен отдавать календарь доступности (миграции 807/808/837).
    const tourQuery = `
      SELECT id, title AS name, max_participants AS max_group_size,
             min_participants AS min_group_size, base_price AS price, is_active
      FROM operator_tours
      WHERE id = $1 AND is_published = true AND deleted_at IS NULL
    `;
    const tourResult = await query<TourCheckRow>(tourQuery, [id]);

    if (tourResult.rows.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'Tour not found'
      } as ApiResponse<null>, { status: 404 });
    }

    const tour = tourResult.rows[0];

    if (!tour.is_active) {
      return NextResponse.json({
        success: false,
        error: 'Tour is not active'
      } as ApiResponse<null>, { status: 400 });
    }

    // Генерируем даты в диапазоне
    const availabilityQuery = `
      WITH RECURSIVE date_series AS (
        SELECT $1::date AS date
        UNION ALL
        SELECT date + 1
        FROM date_series
        WHERE date < $2::date
      )
      -- Занятость считается ПО ДНЮ интервалом, а не группировкой по дате
      -- начала. Прежняя редакция собирала CTE booking_counts с GROUP BY
      -- DATE(booking_date) и подшивала его LEFT JOIN'ом — то есть пятидневная
      -- бронь давала вклад ровно в день выезда, а дни 2..5 оставались
      -- пустыми. Заодно у неё было ДВА отличия от гейта:
      --
      --   1. booking_status IN (confirmed,new) — предикат вида, при
      --      котором pending_payment (оплата уже начата) НЕ занимает место;
      --   2. DATE(booking_date) BETWEEN 1 AND 2 — бронь, начавшаяся ДО
      --      окна и накрывающая его серединой, не попадала в счёт вовсе.
      --      С интервальным предикатом этот фильтр не просто лишний, он
      --      был бы неверен: такую бронь надо считать.
      SELECT
        ds.date::text,
        occ.taken as booked,
        $4::integer as max_capacity,
        ($4::integer - occ.taken) as spots_left,
        CASE
          WHEN ds.date < CURRENT_DATE THEN 'past'
          WHEN occ.taken >= $4::integer THEN 'full'
          ELSE 'available'
        END as status
      FROM date_series ds
      CROSS JOIN LATERAL (
        ${occupiedOnDaySql({ booking: 'b', day: 'ds.date', tourId: '$3' })}
      ) occ
      ORDER BY ds.date
    `;

    const availResult = await query<AvailabilityDateRow>(availabilityQuery, [
      startDate,
      endDate,
      id,
      tour.max_group_size
    ]);

    const availability: AvailabilityDate[] = availResult.rows.map(row => {
      const available = row.status === 'available';
      const spotsLeft = parseInt(row.spots_left);
      
      let reason: string | undefined;
      if (row.status === 'past') {
        reason = 'Дата в прошлом';
      } else if (row.status === 'full') {
        reason = 'Все места заняты';
      }

      return {
        date: row.date,
        available,
        spotsLeft: available ? spotsLeft : 0,
        price: parseFloat(tour.price),
        reason
      };
    });

    return NextResponse.json({
      success: true,
      data: {
        tourId: id,
        tourName: tour.name,
        availability,
        maxGroupSize: tour.max_group_size,
        minGroupSize: tour.min_group_size
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



