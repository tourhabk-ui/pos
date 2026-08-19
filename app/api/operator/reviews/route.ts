import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireOperator } from '@/lib/auth/middleware';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';
import { OpReviewListRow, OpReviewStatsRow, CountRow } from '@/lib/types/db-rows';

export const dynamic = 'force-dynamic';

/**
 * GET /api/operator/reviews
 * Get all reviews for operator's tours
 */
export async function GET(request: NextRequest) {
  try {
    const operatorOrResponse = await requireOperator(request);
    if (operatorOrResponse instanceof NextResponse) {
      return operatorOrResponse;
    }
    const userId = operatorOrResponse.userId;

    const operatorId = await getOperatorPartnerId(userId);
    
    if (!operatorId) {
      return NextResponse.json({
        success: false,
        error: 'Профиль оператора не найден'
      } as ApiResponse<null>, { status: 404 });
    }

    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '20');
    const rating = searchParams.get('rating');
    const tourId = searchParams.get('tourId');
    const offset = (page - 1) * limit;

    // Build query
    /**
     * Отзывы о туре живут в operator_tour_reviews, а не в `reviews`.
     *
     * Прежний запрос соединял `reviews` с `operator_tours` и падал ВСЕГДА:
     * reviews.tour_id объявлен uuid, operator_tours.id — bigint, оператора
     * uuid = bigint в Postgres нет (измерено переписью 19.08). То есть
     * кабинет оператора не показывал отзывы ни дня.
     *
     * Публичный путь перевели на правильную таблицу ещё 06.08; модерацию
     * тогда не перевели, и она осталась на нерабочей стороне.
     *
     * Автор берётся из самой записи (author_name), а не из `users`: отзыв
     * может быть оставлен без учётной записи, и INNER JOIN на users выкинул
     * бы такие отзывы молча. Фото лежат колонкой photos — отдельная связка
     * review_assets к этой таблице не относится.
     */
    let queryStr = `
      SELECT 
        r.id,
        r.tour_id,
        t.title as tour_name,
        r.user_id,
        r.author_name as user_name,
        r.rating,
        r.comment,
        COALESCE((to_jsonb(r)->>'is_hidden')::boolean, FALSE) as is_hidden,
        to_jsonb(r)->>'operator_reply' as operator_reply,
        r.created_at,
        COALESCE(to_jsonb(r)->>'updated_at', r.created_at::text) as updated_at,
        COALESCE(r.photos, '{}') as photos
      FROM operator_tour_reviews r
      JOIN operator_tours t ON r.tour_id = t.id
      WHERE t.operator_id = $1
    `;

    const params: (string | number | boolean | null)[] = [operatorId];
    let paramIndex = 2;

    // Rating filter
    if (rating) {
      queryStr += ` AND r.rating = $${paramIndex}`;
      params.push(parseInt(rating));
      paramIndex++;
    }

    // Tour filter
    if (tourId) {
      queryStr += ` AND r.tour_id = $${paramIndex}`;
      params.push(tourId);
      paramIndex++;
    }

    queryStr += `
      ORDER BY r.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    params.push(limit, offset);

    const result = await query<OpReviewListRow>(queryStr, params);

    // Get total count
    let countQuery = `
      SELECT COUNT(*) 
      FROM operator_tour_reviews r
      JOIN operator_tours t ON r.tour_id = t.id
      WHERE t.operator_id = $1
    `;
    const countParams: (string | number | boolean | null)[] = [operatorId];
    let countIndex = 2;

    if (rating) {
      countQuery += ` AND r.rating = $${countIndex}`;
      countParams.push(parseInt(rating));
      countIndex++;
    }

    if (tourId) {
      countQuery += ` AND r.tour_id = $${countIndex}`;
      countParams.push(tourId);
    }

    const countResult = await query<CountRow>(countQuery, countParams);
    const totalCount = parseInt(countResult.rows[0].count);

    const reviews = result.rows.map(row => ({
      id: row.id,
      tourId: row.tour_id,
      tourName: row.tour_name,
      userId: row.user_id,
      userName: row.user_name,
      rating: row.rating,
      comment: row.comment,
      // «Скрыт модерацией», а не «проверен»: отзывы о турах публикуются сразу,
      // и называть проверенным то, что никто не проверял, — соврать в поле.
      isHidden: row.is_hidden,
      operatorReply: row.operator_reply,
      photos: row.photos,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));

    // Get rating distribution
    const statsResult = await query<OpReviewStatsRow>(
      `SELECT 
        COUNT(*) as total_reviews,
        AVG(r.rating) as avg_rating,
        COUNT(CASE WHEN r.rating = 5 THEN 1 END) as five_stars,
        COUNT(CASE WHEN r.rating = 4 THEN 1 END) as four_stars,
        COUNT(CASE WHEN r.rating = 3 THEN 1 END) as three_stars,
        COUNT(CASE WHEN r.rating = 2 THEN 1 END) as two_stars,
        COUNT(CASE WHEN r.rating = 1 THEN 1 END) as one_star
      FROM operator_tour_reviews r
      JOIN operator_tours t ON r.tour_id = t.id
      WHERE t.operator_id = $1`,
      [operatorId]
    );

    const stats = statsResult.rows[0];

    return NextResponse.json({
      success: true,
      data: {
        reviews,
        stats: {
          totalReviews: parseInt(stats.total_reviews),
          avgRating: parseFloat(stats.avg_rating ?? '0').toFixed(2),
          distribution: {
            5: parseInt(stats.five_stars),
            4: parseInt(stats.four_stars),
            3: parseInt(stats.three_stars),
            2: parseInt(stats.two_stars),
            1: parseInt(stats.one_star)
          }
        },
        pagination: {
          page,
          limit,
          totalCount,
          totalPages: Math.ceil(totalCount / limit)
        }
      }
    } as ApiResponse<unknown>);

  } catch (error) {
    return NextResponse.json({
      success: false,
      error: 'Ошибка при получении отзывов'
    } as ApiResponse<null>, { status: 500 });
  }
}
