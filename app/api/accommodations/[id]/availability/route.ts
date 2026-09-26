import { NextRequest, NextResponse } from 'next/server';
import { publicAccommodationSql } from '@/lib/stay/moderation';
import { z } from 'zod';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { roomNightsSql, KAMCHATKA_TODAY_SQL } from '@/lib/stay/availability';
import { logStayFailure } from '@/lib/notifications/stay-booking';

export const dynamic = 'force-dynamic';

interface NightAvailability {
  date: string;
  available: boolean;
  /** Сколько номеров можно продать в эту ночь (с учётом числа владельца на дату) */
  roomsLeft: number;
  /** Цена ночи «от» — самая низкая из номеров; null — у объекта нет номеров */
  price: number | null;
  reason?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NIGHTS = 400;

const querySchema = z.object({
  id: z.string().uuid('Некорректный ID объекта'),
  checkIn: z.string().regex(ISO_DATE, 'Дата заезда: формат YYYY-MM-DD'),
  checkOut: z.string().regex(ISO_DATE, 'Дата выезда: формат YYYY-MM-DD'),
  roomId: z.string().uuid('Некорректный ID номера').optional(),
});

/**
 * GET /api/accommodations/[id]/availability?checkIn&checkOut[&roomId]
 * Public by design: availability check for accommodation selection.
 *
 * Ночи — полуинтервал [checkIn, checkOut), как у брони. Занятость — ПО
 * НОМЕРАМ единой формулой (lib/stay/availability.ts): объект с пятью
 * номерами и одной бронью свободен на четыре. С roomId — только этот номер.
 *
 * До 26.09 здесь делилось на `total_rooms || 10` (десятку никто не
 * объявлял), брони всех номеров считались против одного числа, число
 * владельца на дату и блоки уровня номера не читались, а пустая цена
 * объекта превращалась в NaN.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);

    // Поддерживаем оба варианта параметров
    const parsed = querySchema.safeParse({
      id,
      checkIn: searchParams.get('checkIn') || searchParams.get('startDate') || undefined,
      checkOut: searchParams.get('checkOut') || searchParams.get('endDate') || undefined,
      roomId: searchParams.get('roomId') || undefined,
    });
    if (!parsed.success) {
      return NextResponse.json({
        success: false,
        error: parsed.error.issues[0]?.message ?? 'Нужны даты заезда и выезда',
      } as ApiResponse<null>, { status: 400 });
    }
    const { checkIn, checkOut, roomId } = parsed.data;
    const nights = (Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000;
    if (!(nights >= 1) || nights > MAX_NIGHTS) {
      return NextResponse.json({
        success: false,
        error: 'Дата выезда должна быть позже даты заезда (не больше 400 ночей)',
      } as ApiResponse<null>, { status: 400 });
    }

    const accommResult = await query<{ id: string; name: string; is_public: boolean }>(
      `SELECT id, name, ${publicAccommodationSql('')} AS is_public FROM accommodations WHERE id = $1`,
      [id]
    );

    if (accommResult.rows.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'Объект размещения не найден'
      } as ApiResponse<null>, { status: 404 });
    }

    const accommodation = accommResult.rows[0];

    if (!accommodation.is_public) {
      return NextResponse.json({
        success: false,
        error: 'Объект размещения не принимает брони'
      } as ApiResponse<null>, { status: 400 });
    }

    // По ночам: сумма свободного по номерам (закрытый номер — ноль), но не
    // больше остатка по числу владельца на весь объект. LEAST пропускает
    // NULL: нет числа уровня объекта — нет и этого ограничения.
    const params: unknown[] = [id, checkIn, checkOut];
    if (roomId) params.push(roomId);
    const availResult = await query<{
      date: string; rooms_left: number; all_blocked: boolean; min_price: string | null; past: boolean;
    }>(
      `WITH rn AS (${roomNightsSql({
        accommodation: '$1::uuid', start: '$2::date', endExclusive: '$3::date',
        room: roomId ? '$4' : undefined,
      })})
       SELECT rn.night AS date,
              GREATEST(0, LEAST(
                SUM(CASE WHEN rn.blocked THEN 0 ELSE rn.free_units END),
                MIN(rn.object_free)
              ))::int AS rooms_left,
              bool_and(rn.blocked) AS all_blocked,
              MIN(rn.price)::text AS min_price,
              (rn.night::date < ${KAMCHATKA_TODAY_SQL}) AS past
         FROM rn
        GROUP BY rn.night
        ORDER BY rn.night`,
      params
    );

    // Нет ни одного активного номера (или указанный номер не из этого
    // объекта) — продавать нечего. Это не «всё занято» и не «10 свободно».
    if (availResult.rows.length === 0) {
      return NextResponse.json({
        success: true,
        data: {
          accommodationId: id,
          accommodationName: accommodation.name,
          available: false,
          reason: roomId ? 'Номер не найден в этом объекте' : 'У объекта нет номеров для онлайн-бронирования',
          availability: [],
          totalRooms: null,
        }
      } as ApiResponse<unknown>);
    }

    const availability: NightAvailability[] = availResult.rows.map(row => {
      let reason: string | undefined;
      if (row.past) reason = 'Дата в прошлом';
      else if (row.all_blocked) reason = 'Владелец закрыл продажу на эту дату';
      else if (Number(row.rooms_left) < 1) reason = 'Все номера заняты';
      const available = reason === undefined;
      return {
        date: row.date,
        available,
        roomsLeft: available ? Number(row.rooms_left) : 0,
        price: row.min_price == null ? null : Number(row.min_price),
        reason,
      };
    });

    const allAvailable = availability.every(a => a.available);
    const firstBad = availability.find(a => !a.available);

    // Фонд — сумма номеров по объекту (или номеру), а не выдуманная десятка
    const stockResult = await query<{ stock: string | null }>(
      `SELECT SUM(available_rooms)::text AS stock FROM accommodation_rooms
        WHERE accommodation_id = $1 AND is_active = true ${roomId ? 'AND id = $2' : ''}`,
      roomId ? [id, roomId] : [id]
    );
    const stock = stockResult.rows[0]?.stock;

    return NextResponse.json({
      success: true,
      data: {
        accommodationId: id,
        accommodationName: accommodation.name,
        available: allAvailable,
        reason: firstBad ? `${firstBad.date.split('-').reverse().join('.')}: ${firstBad.reason}` : undefined,
        availability,
        totalRooms: stock == null ? null : Number(stock),
      }
    } as ApiResponse<unknown>);

  } catch (error) {
    logStayFailure('availability: доступность не посчитана', error);
    return NextResponse.json({
      success: false,
      error: 'Не удалось проверить доступность',
    } as ApiResponse<null>, { status: 500 });
  }
}
