import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';

export const dynamic = 'force-dynamic';

interface PriceInfo {
  date: string;
  price: number;
  /** override — владелец задал цену на дату; base — базовая цена объекта */
  type: 'override' | 'base';
  isBlocked: boolean;
}

/**
 * GET /api/accommodations/[id]/prices
 * Цены по датам: базовая цена + реальные тарифы владельца из
 * accommodation_availability. Без ?roomId= — уровень объекта
 * (room_id IS NULL, базовая = price_per_night_from). С ?roomId= —
 * приоритеты как в book-роуте: override номера > override объекта >
 * базовая цена номера; блокировка любого уровня закрывает дату.
 * Никаких выдуманных «динамических» наценок: нет тарифа — базовая цена.
 * Public by design: price info for accommodation selection.
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

    if (!startDate || !endDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return NextResponse.json({
        success: false,
        error: 'Нужны startDate и endDate в формате YYYY-MM-DD'
      } as ApiResponse<null>, { status: 400 });
    }

    const accommResult = await query<{ id: string; name: string; price_per_night_from: string; is_active: boolean }>(
      `SELECT id, name, price_per_night_from, is_active
       FROM accommodations
       WHERE id = $1`,
      [id]
    );

    if (accommResult.rows.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'Объект размещения не найден'
      } as ApiResponse<null>, { status: 404 });
    }

    const accommodation = accommResult.rows[0];

    if (!accommodation.is_active) {
      return NextResponse.json({
        success: false,
        error: 'Объект размещения не активен'
      } as ApiResponse<null>, { status: 400 });
    }

    // Уровень номера: базовая цена номера + приоритет его override
    const roomId = searchParams.get('roomId');
    let roomBasePrice: string | null = null;
    if (roomId) {
      if (!/^[0-9a-f-]{36}$/i.test(roomId)) {
        return NextResponse.json({
          success: false,
          error: 'Некорректный roomId'
        } as ApiResponse<null>, { status: 400 });
      }
      const roomResult = await query<{ price_per_night: string }>(
        `SELECT price_per_night FROM accommodation_rooms
         WHERE id = $1 AND accommodation_id = $2 AND is_active = true`,
        [roomId, id]
      );
      if (roomResult.rows.length === 0) {
        return NextResponse.json({
          success: false,
          error: 'Номер не найден в этом объекте'
        } as ApiResponse<null>, { status: 404 });
      }
      roomBasePrice = roomResult.rows[0].price_per_night;
    }

    const basePrice = roomBasePrice ?? accommodation.price_per_night_from;

    const pricesResult = roomId
      ? await query<{ date: string; price: string; has_override: boolean; is_blocked: boolean }>(
          `SELECT
             ds.date::date::text,
             COALESCE(rv.price_override, av.price_override, $4::numeric) AS price,
             (rv.price_override IS NOT NULL OR av.price_override IS NOT NULL) AS has_override,
             (COALESCE(rv.is_blocked, false) OR COALESCE(av.is_blocked, false)) AS is_blocked
           FROM generate_series($1::date, $2::date, '1 day') AS ds(date)
           LEFT JOIN accommodation_availability av
             ON av.accommodation_id = $3 AND av.room_id IS NULL AND av.date = ds.date
           LEFT JOIN accommodation_availability rv
             ON rv.accommodation_id = $3 AND rv.room_id = $5 AND rv.date = ds.date
           ORDER BY ds.date`,
          [startDate, endDate, id, basePrice, roomId]
        )
      : await query<{ date: string; price: string; has_override: boolean; is_blocked: boolean }>(
          `SELECT
             ds.date::date::text,
             COALESCE(av.price_override, $4::numeric) AS price,
             (av.price_override IS NOT NULL) AS has_override,
             COALESCE(av.is_blocked, false) AS is_blocked
           FROM generate_series($1::date, $2::date, '1 day') AS ds(date)
           LEFT JOIN accommodation_availability av
             ON av.accommodation_id = $3
            AND av.room_id IS NULL
            AND av.date = ds.date
           ORDER BY ds.date`,
          [startDate, endDate, id, basePrice]
        );

    const prices: PriceInfo[] = pricesResult.rows.map(row => ({
      date: row.date,
      price: Math.round(parseFloat(row.price)),
      type: row.has_override ? 'override' : 'base',
      isBlocked: row.is_blocked,
    }));

    return NextResponse.json({
      success: true,
      data: {
        accommodationId: id,
        accommodationName: accommodation.name,
        roomId: roomId ?? null,
        startDate,
        endDate,
        basePrice: parseFloat(basePrice),
        prices
      }
    } as ApiResponse<unknown>);

  } catch (error) {
    return NextResponse.json({
      success: false,
      error: 'Не удалось получить цены',
      message: error instanceof Error ? error.message : 'Unknown error'
    } as ApiResponse<null>, { status: 500 });
  }
}
