import { NextRequest, NextResponse } from 'next/server';
import { ApiResponse } from '@/types';
import { query } from '@/lib/database';
import { z } from 'zod';

/**
 * GET /api/reviews — публичный список отзывов о турах (фильтры: тур, оператор).
 *
 * Читает operator_tour_reviews — единственную живую таблицу отзывов о турах
 * (миграция 087; запись — POST /api/reviews/tour/[tourId]).
 *
 * До 27.08 здесь читалась старая `reviews` с JOIN'ом
 * `r.tour_id (uuid) = operator_tours.id (bigint)` — ошибка 42883 на каждом
 * запросе, которую catch превращал в вечный пустой degraded-список. Список
 * был не пустым, а НЕИЗМЕРЯЕМЫМ (§4.0).
 *
 * POST здесь удалён: он писал в ту же мёртвую `reviews` (вставка числового id
 * тура в UUID-колонку падает всегда) — отзыв не создался ни разу. Запись
 * отзыва — только канонический POST /api/reviews/tour/[tourId] с гейтом
 * завершённой брони; кабинет туриста переведён на него.
 */

const reviewListQuerySchema = z.object({
  tourId: z.coerce.number().int().positive().optional(),
  operatorId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  offset: z.coerce.number().int().min(0).default(0),
});

function queryParamOrUndefined(searchParams: URLSearchParams, key: string): string | undefined {
  const value = searchParams.get(key);
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const parsedQuery = reviewListQuerySchema.safeParse({
      tourId: queryParamOrUndefined(searchParams, 'tourId'),
      operatorId: queryParamOrUndefined(searchParams, 'operatorId'),
      limit: queryParamOrUndefined(searchParams, 'limit'),
      offset: queryParamOrUndefined(searchParams, 'offset'),
    });

    if (!parsedQuery.success) {
      return NextResponse.json(
        {
          success: false,
          error: 'Неверные параметры запроса',
          details: parsedQuery.error.flatten(),
        } as ApiResponse<null>,
        { status: 400 }
      );
    }

    const { tourId, operatorId, limit, offset } = parsedQuery.data;

    const conditions: string[] = [
      // Скрытые модерацией — не показываем; is_hidden может отставать
      // (миграция 878), поэтому через to_jsonb — как в каноническом роуте.
      `COALESCE((to_jsonb(r)->>'is_hidden')::boolean, FALSE) = FALSE`,
    ];
    const params: unknown[] = [];

    if (tourId !== undefined) {
      params.push(tourId);
      conditions.push(`r.tour_id = $${params.length}`);
    }
    if (operatorId) {
      params.push(operatorId);
      conditions.push(`t.operator_id = $${params.length}`);
    }

    params.push(limit, offset);
    const result = await query<{
      id: number;
      tour_id: number;
      author_name: string;
      rating: number;
      comment: string;
      photos: string[] | null;
      created_at: string;
      tour_name: string | null;
    }>(
      `SELECT r.id, r.tour_id, r.author_name, r.rating, r.comment,
              (to_jsonb(r)->'photos') AS photos,
              r.created_at,
              t.title AS tour_name
         FROM operator_tour_reviews r
         LEFT JOIN operator_tours t ON r.tour_id = t.id
        WHERE ${conditions.join(' AND ')}
        ORDER BY r.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const reviews = result.rows.map(row => ({
      id: row.id,
      tourId: row.tour_id,
      tourName: row.tour_name,
      authorName: row.author_name,
      rating: row.rating,
      comment: row.comment,
      images: Array.isArray(row.photos) ? row.photos : [],
      createdAt: row.created_at,
    }));

    return NextResponse.json({
      success: true,
      data: reviews,
    } as ApiResponse<typeof reviews>);
  } catch {
    return NextResponse.json(
      { success: false, error: 'Ошибка при получении отзывов' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
