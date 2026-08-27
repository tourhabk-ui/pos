import { NextRequest, NextResponse } from 'next/server';
import { ApiResponse } from '@/types';
import { query } from '@/lib/database';
import { requireAuth } from '@/lib/auth/middleware';

export const dynamic = 'force-dynamic';

/**
 * GET /api/reviews/my — Мои отзывы (отзывы текущего пользователя о турах)
 *
 * Читает operator_tour_reviews — ту же таблицу, куда пишет канонический
 * POST /api/reviews/tour/[tourId] и которую рендерит карточка тура.
 *
 * До 27.08 читалась старая `reviews` с JOIN'ом
 * `r.tour_id (uuid) = operator_tours.id (bigint)` — сравнение несовместимых
 * типов, ошибка 42883 на КАЖДОМ запросе, и «Мои отзывы» не открывались ни
 * разу («Ошибка при получении отзывов»). Тот же дефект в форме записи уже
 * чинился 06.08 (см. tour-review-write-path.test.ts) — но кабинет туриста
 * тогда не тронули.
 */
export async function GET(request: NextRequest) {
  try {
    const userOrResponse = await requireAuth(request);
    if (userOrResponse instanceof NextResponse) return userOrResponse;

    const userId = userOrResponse.userId;
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10) || 20, 100);
    const offset = parseInt(searchParams.get('offset') ?? '0', 10) || 0;

    const result = await query<{
      id: number;
      tour_id: number;
      rating: number;
      comment: string;
      photos: string[] | null;
      created_at: string;
      tour_name: string | null;
    }>(
      // photos через to_jsonb: колонка пришла миграцией 832 вместе с user_id,
      // но если 832 отстала, у таблицы нет и user_id — тогда честно падаем в
      // catch, а не показываем чужие отзывы.
      `SELECT r.id, r.tour_id, r.rating, r.comment,
              (to_jsonb(r)->'photos') AS photos,
              r.created_at,
              t.title AS tour_name
         FROM operator_tour_reviews r
         LEFT JOIN operator_tours t ON r.tour_id = t.id
        WHERE r.user_id = $1
        ORDER BY r.created_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    const countResult = await query<{ total: string }>(
      `SELECT COUNT(*) AS total FROM operator_tour_reviews WHERE user_id = $1`,
      [userId]
    );

    const reviews = result.rows.map(row => ({
      id: row.id,
      tourId: row.tour_id,
      tourName: row.tour_name,
      rating: row.rating,
      comment: row.comment,
      images: Array.isArray(row.photos) ? row.photos : [],
      createdAt: row.created_at,
    }));

    return NextResponse.json({
      success: true,
      data: {
        reviews,
        total: parseInt(countResult.rows[0].total, 10),
      },
    } as ApiResponse<{ reviews: typeof reviews; total: number }>);
  } catch {
    return NextResponse.json(
      { success: false, error: 'Ошибка при получении отзывов' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
