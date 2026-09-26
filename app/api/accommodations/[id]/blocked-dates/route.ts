import { NextRequest, NextResponse } from 'next/server';
import { publicAccommodationSql } from '@/lib/stay/moderation';
import { z } from 'zod';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { roomNightsSql } from '@/lib/stay/availability';
import { logStayFailure } from '@/lib/notifications/stay-booking';

export const dynamic = 'force-dynamic';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 400;

const querySchema = z.object({
  id: z.string().uuid('Некорректный ID объекта'),
  startDate: z.string().regex(ISO_DATE, 'startDate: формат YYYY-MM-DD'),
  endDate: z.string().regex(ISO_DATE, 'endDate: формат YYYY-MM-DD'),
  roomId: z.string().uuid('Некорректный ID номера').optional(),
});

/**
 * GET /api/accommodations/[id]/blocked-dates?startDate&endDate[&roomId]
 * Даты [startDate, endDate], на которые ночь продать НЕЛЬЗЯ: ни у одного
 * номера (или у указанного номера) нет свободного места, либо продажа
 * закрыта владельцем. Public by design: blocked dates for calendar display.
 *
 * До 26.09 дата закрывалась, если в объекте была ХОТЬ ОДНА бронь: база с
 * пятью номерами и одной бронью выглядела для гостя полностью занятой.
 * Теперь занятость — по номерам единой формулой (lib/stay/availability.ts),
 * с блоками уровня номера и числом владельца на дату.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);

    const parsed = querySchema.safeParse({
      id,
      startDate: searchParams.get('startDate') || undefined,
      endDate: searchParams.get('endDate') || undefined,
      roomId: searchParams.get('roomId') || undefined,
    });
    if (!parsed.success) {
      return NextResponse.json({
        success: false,
        error: parsed.error.issues[0]?.message ?? 'Нужны startDate и endDate',
      } as ApiResponse<null>, { status: 400 });
    }
    const { startDate, endDate, roomId } = parsed.data;
    const days = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000 + 1;
    if (!(days >= 1) || days > MAX_DAYS) {
      return NextResponse.json({
        success: false,
        error: 'Диапазон дат: от одного дня до 400',
      } as ApiResponse<null>, { status: 400 });
    }

    const accommResult = await query<{ id: string; is_public: boolean }>(
      `SELECT id, ${publicAccommodationSql('')} AS is_public FROM accommodations WHERE id = $1`,
      [id]
    );

    if (accommResult.rows.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'Объект размещения не найден'
      } as ApiResponse<null>, { status: 404 });
    }

    if (!accommResult.rows[0].is_public) {
      return NextResponse.json({
        success: false,
        error: 'Объект размещения не принимает брони'
      } as ApiResponse<null>, { status: 400 });
    }

    // Ночь закрыта, если продать нечего: по каждому номеру либо блок, либо
    // ноль свободных, либо исчерпано число владельца на весь объект.
    const params: unknown[] = [id, startDate, endDate];
    if (roomId) params.push(roomId);
    const blockedResult = await query<{ date: string }>(
      `WITH rn AS (${roomNightsSql({
        accommodation: '$1::uuid', start: '$2::date', endExclusive: '($3::date + 1)',
        room: roomId ? '$4' : undefined,
      })})
       SELECT rn.night AS date
         FROM rn
        GROUP BY rn.night
       HAVING GREATEST(0, LEAST(
                SUM(CASE WHEN rn.blocked THEN 0 ELSE rn.free_units END),
                MIN(rn.object_free)
              )) < 1
        ORDER BY rn.night`,
      params
    );
    const blockedDates = blockedResult.rows.map(row => row.date);

    return NextResponse.json({
      success: true,
      data: {
        accommodationId: id,
        roomId: roomId ?? null,
        startDate,
        endDate,
        blockedDates,
        blockedCount: blockedDates.length
      }
    } as ApiResponse<unknown>);

  } catch (error) {
    logStayFailure('blocked-dates: занятость не посчитана', error);
    return NextResponse.json({
      success: false,
      error: 'Не удалось получить занятые даты',
    } as ApiResponse<null>, { status: 500 });
  }
}
