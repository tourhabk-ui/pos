/**
 * API endpoint для получения списка размещений
 * GET /api/accommodations
 * 
 * Query параметры:
 * - page: номер страницы (default: 1)
 * - limit: количество на странице (default: 20)
 * - type: тип размещения (hotel, hostel, apartment...)
 * - price_min: минимальная цена
 * - price_max: максимальная цена
 * - rating_min: минимальный рейтинг
 * - amenities: удобства (comma-separated)
 * - location_zone: зона расположения
 * - sort: сортировка (price_asc, price_desc, rating_desc, distance)
 * - search: поиск по названию
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

// Префикс a. обязателен: запрос джойнит partners, у которых свои
// rating/review_count/name — без префикса сортировка была бы ambiguous.
const ACCOMMODATIONS_SORT_SQL = {
  price_asc: 'a.price_per_night_from ASC',
  price_desc: 'a.price_per_night_from DESC',
  rating_desc: 'a.rating DESC, a.review_count DESC',
  name_asc: 'a.name ASC',
} as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const accommodationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  type: z.string().trim().min(1).optional(),
  price_min: z.coerce.number().nonnegative().optional(),
  price_max: z.coerce.number().nonnegative().optional(),
  rating_min: z.coerce.number().min(0).max(5).optional(),
  amenities: z.string().trim().min(1).optional(),
  location_zone: z.string().trim().min(1).optional(),
  search: z.string().trim().max(200).optional(),
  // Поиск по датам (Booking-паттерн): показываем только объекты, где есть
  // номер, свободный на ВСЕ ночи окна и не закрытый календарём владельца.
  check_in: z.string().regex(ISO_DATE).optional(),
  check_out: z.string().regex(ISO_DATE).optional(),
  sort: z.enum(['price_asc', 'price_desc', 'rating_desc', 'name_asc']).default('rating_desc'),
});

function paramOrUndefined(searchParams: URLSearchParams, key: string): string | undefined {
  const raw = searchParams.get(key);
  if (!raw) {
    return undefined;
  }

  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}

// GET /api/accommodations - Public by design: catalog listing for discovery.
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const parsedQuery = accommodationsQuerySchema.safeParse({
      page: paramOrUndefined(searchParams, 'page'),
      limit: paramOrUndefined(searchParams, 'limit'),
      type: paramOrUndefined(searchParams, 'type'),
      price_min: paramOrUndefined(searchParams, 'price_min'),
      price_max: paramOrUndefined(searchParams, 'price_max'),
      rating_min: paramOrUndefined(searchParams, 'rating_min'),
      amenities: paramOrUndefined(searchParams, 'amenities'),
      location_zone: paramOrUndefined(searchParams, 'location_zone'),
      search: paramOrUndefined(searchParams, 'search'),
      sort: paramOrUndefined(searchParams, 'sort'),
    });

    if (!parsedQuery.success) {
      return NextResponse.json(
        {
          success: false,
          error: 'Некорректные параметры запроса',
          details: parsedQuery.error.flatten(),
        },
        { status: 400 }
      );
    }

    const {
      page,
      limit,
      type,
      price_min: priceMin,
      price_max: priceMax,
      rating_min: ratingMin,
      amenities: amenitiesStr,
      location_zone: locationZone,
      search,
      check_in: checkIn,
      check_out: checkOut,
      sort,
    } = parsedQuery.data;

    if (priceMin !== undefined && priceMax !== undefined && priceMin > priceMax) {
      return NextResponse.json(
        {
          success: false,
          error: 'Некорректные параметры запроса',
          details: { price: ['price_min не может быть больше price_max'] },
        },
        { status: 400 }
      );
    }

    if ((checkIn && !checkOut) || (!checkIn && checkOut) || (checkIn && checkOut && checkOut <= checkIn)) {
      return NextResponse.json(
        {
          success: false,
          error: 'Некорректные параметры запроса',
          details: { dates: ['нужны обе даты, выезд — позже заезда'] },
        },
        { status: 400 }
      );
    }

    const offset = (page - 1) * limit;

    // Строим WHERE условия. Все колонки — с префиксом a.: основной запрос
    // джойнит partners, а у partners есть свои name/rating/is_verified —
    // без префикса фильтры search и rating_min падали «column reference
    // is ambiguous» (500 на живом каталоге).
    const conditions: string[] = ['a.is_active = true'];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (type) {
      conditions.push(`a.type = $${paramIndex++}`);
      params.push(type);
    }

    if (priceMin !== undefined) {
      conditions.push(`a.price_per_night_from >= $${paramIndex++}`);
      params.push(priceMin);
    }

    if (priceMax !== undefined) {
      conditions.push(`a.price_per_night_from <= $${paramIndex++}`);
      params.push(priceMax);
    }

    if (ratingMin !== undefined) {
      conditions.push(`a.rating >= $${paramIndex++}`);
      params.push(ratingMin);
    }

    if (locationZone) {
      conditions.push(`a.location_zone = $${paramIndex++}`);
      params.push(locationZone);
    }

    if (search) {
      conditions.push(`(a.name ILIKE $${paramIndex} OR a.description ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    // Фильтр по удобствам (amenities)
    if (amenitiesStr) {
      const amenities = amenitiesStr
        .split(',')
        .map(a => a.trim())
        .filter(Boolean)
        .slice(0, 20);
      if (amenities.length > 0) {
        conditions.push(`a.amenities @> $${paramIndex++}::jsonb`);
        params.push(JSON.stringify(amenities));
      }
    }

    // Доступность на даты: есть активный номер, у которого (1) ни одна ночь
    // окна не закрыта календарём владельца (блок уровня объекта или номера) и
    // (2) ни в одну ночь окна пересекающиеся брони не выбирают весь его сток.
    // Та же семантика, что в book-роуте, — каталог не обещает того, что бронь
    // потом отклонит.
    if (checkIn && checkOut) {
      const ci = `$${paramIndex++}`;
      const co = `$${paramIndex++}`;
      params.push(checkIn, checkOut);
      conditions.push(`EXISTS (
        SELECT 1 FROM accommodation_rooms r
        WHERE r.accommodation_id = a.id AND r.is_active = true
          AND NOT EXISTS (
            SELECT 1 FROM accommodation_availability av
            WHERE av.accommodation_id = a.id
              AND (av.room_id IS NULL OR av.room_id = r.id)
              AND av.is_blocked
              AND av.date >= ${ci}::date AND av.date < ${co}::date
          )
          AND NOT EXISTS (
            SELECT 1
            FROM generate_series(${ci}::date, ${co}::date - 1, '1 day') AS d(day)
            JOIN accommodation_bookings b
              ON b.room_id = r.id
             AND b.status NOT IN ('cancelled')
             AND b.check_in_date <= d.day
             AND b.check_out_date > d.day
            GROUP BY d.day
            HAVING COUNT(*) >= r.available_rooms
          )
      )`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderBy = ACCOMMODATIONS_SORT_SQL[sort];

    // Получаем общее количество (тот же алиас a, что и в основном запросе)
    const countResult = await query<{ total: string }>(
      `SELECT COUNT(*) as total FROM accommodations a ${whereClause}`,
      params
    );
    const total = Number.parseInt(countResult.rows[0]?.total || '0', 10);

    // Получаем список объектов
    const accommodationsQuery = `
      SELECT 
        a.id,
        a.name,
        a.type,
        a.description,
        a.short_description,
        a.address,
        a.coordinates,
        a.location_zone,
        a.star_rating,
        a.price_per_night_from,
        a.price_per_night_to,
        a.currency,
        a.amenities,
        a.rating,
        a.review_count,
        a.is_verified,
        a.created_at,
        p.name as partner_name,
        (
          SELECT json_agg(json_build_object('url', ast.url, 'alt', ast.alt))
          FROM accommodation_assets aa
          JOIN assets ast ON aa.asset_id = ast.id
          WHERE aa.accommodation_id = a.id
          LIMIT 5
        ) as images
      FROM accommodations a
      LEFT JOIN partners p ON a.partner_id = p.id
      ${whereClause}
      ORDER BY a.is_verified DESC, ${orderBy}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    
    params.push(limit, offset);
    
    const result = await query<{
      id: string; name: string; type: string; description: string | null; short_description: string | null;
      address: string; coordinates: unknown; location_zone: string; star_rating: unknown;
      price_per_night_from: string; price_per_night_to: string | null; currency: string;
      amenities: unknown; rating: string | null; review_count: unknown; is_verified: boolean;
      created_at: unknown; partner_name: string | null; images: unknown;
    }>(accommodationsQuery, params);
    
    // Форматируем данные
    const accommodations = result.rows.map(row => ({
      id: row.id,
      name: row.name,
      type: row.type,
      description: row.short_description || row.description?.substring(0, 200),
      address: row.address,
      coordinates: row.coordinates,
      locationZone: row.location_zone,
      starRating: row.star_rating,
      pricePerNight: {
        from: parseFloat(row.price_per_night_from),
        to: row.price_per_night_to ? parseFloat(row.price_per_night_to) : null,
        currency: row.currency,
      },
      amenities: row.amenities || [],
      rating: row.rating ? parseFloat(row.rating) : 0,
      reviewCount: row.review_count || 0,
      isVerified: row.is_verified,
      partnerName: row.partner_name,
      images: row.images || [],
      createdAt: row.created_at,
    }));
    
    // Метаданные пагинации
    const totalPages = Math.ceil(total / limit);
    
    return NextResponse.json({
      success: true,
      data: {
        accommodations,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
        },
        filters: {
          type,
          priceMin: priceMin ?? null,
          priceMax: priceMax ?? null,
          ratingMin: ratingMin ?? null,
          amenities: amenitiesStr,
          locationZone,
          search,
          checkIn: checkIn ?? null,
          checkOut: checkOut ?? null,
          sort,
        },
      },
    });
    
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: 'Ошибка при получении списка размещений',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}



