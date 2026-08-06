/**
 * Отзывы о туре — чтение и запись ОДНОЙ таблицы: operator_tour_reviews.
 *
 * До 06.08 здесь было раздвоение: GET и POST работали со старой `reviews`
 * (tour_id UUID, FK на удалённую таблицу tours), а карточка тура показывает
 * operator_tour_reviews (tour_id BIGINT, миграция 087). Вставка числового id
 * в UUID-колонку падает всегда — «Оставить отзыв» не срабатывал ни разу, а
 * catch прятал причину за «Ошибка при создании отзыва». Даже пройди вставка —
 * отзыв ушёл бы в таблицу, которую никто не читает.
 *
 * Правила записи:
 *  - отзыв только при завершённой брони этого тура (гейт честности);
 *  - один отзыв на тур от пользователя;
 *  - фото — только с нашего S3 или из /images/ (чужие хосты не встраиваем);
 *  - отказ БД наружу словами (redactPII), не немым 500 — слепота этого catch
 *    уже стоила круга диагностики.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireAuth } from '@/lib/auth/middleware';
import { getColumnTypes, valueForColumn } from '@/lib/db/column-types';
import { redactPII } from '@/lib/security/pii-redact';

export const dynamic = 'force-dynamic';

/** Фото из отзыва: наш S3 или наш относительный путь — ничего чужого. */
function isOwnPhotoUrl(u: string): boolean {
  return u.startsWith('https://s3.twcstorage.ru/') || (u.startsWith('/') && !u.startsWith('//'));
}

const ReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(4000).optional().default(''),
  photos: z.array(z.string().max(500)).max(3).optional().default([]),
});

/**
 * GET /api/reviews/tour/[tourId] — публичный список из той же таблицы,
 * что рендерит карточка (иначе API и страница показывали бы разные отзывы).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tourId: string }> }
) {
  try {
    const { tourId } = await params;
    const id = parseInt(tourId);
    if (isNaN(id)) {
      return NextResponse.json({ success: false, error: 'Неверный id тура' } as ApiResponse<null>, { status: 400 });
    }
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
    const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') || '20')));
    const offset = (page - 1) * limit;

    const result = await query<{
      id: number; author_name: string; author_city: string | null;
      rating: number; comment: string; trip_date: string | null;
      photos: string[] | null; created_at: string;
    }>(
      `SELECT id, author_name, author_city, rating, comment, trip_date, photos, created_at
         FROM operator_tour_reviews
        WHERE tour_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [id, limit, offset]
    );

    const summaryResult = await query<{
      total_reviews: string; avg_rating: string | null;
    }>(
      `SELECT COUNT(*) AS total_reviews, AVG(rating) AS avg_rating
         FROM operator_tour_reviews WHERE tour_id = $1`,
      [id]
    );
    const summary = summaryResult.rows[0];
    const totalCount = parseInt(summary.total_reviews);

    return NextResponse.json({
      success: true,
      data: {
        reviews: result.rows,
        summary: {
          totalReviews: totalCount,
          avgRating: summary.avg_rating ? parseFloat(summary.avg_rating).toFixed(2) : '0.00',
        },
        pagination: { page, limit, totalCount, totalPages: Math.ceil(totalCount / limit) },
      },
    } as ApiResponse<unknown>);
  } catch {
    return NextResponse.json({
      success: false,
      error: 'Ошибка при получении отзывов',
    } as ApiResponse<null>, { status: 500 });
  }
}

/**
 * POST /api/reviews/tour/[tourId] — отзыв туриста (auth + завершённая бронь).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tourId: string }> }
) {
  try {
    const authResult = await requireAuth(request);
    if (authResult instanceof NextResponse) return authResult;
    const userId = authResult.userId;

    const { tourId } = await params;
    const id = parseInt(tourId);
    if (isNaN(id)) {
      return NextResponse.json({ success: false, error: 'Неверный id тура' } as ApiResponse<null>, { status: 400 });
    }

    let rawBody: unknown;
    try { rawBody = await request.json(); }
    catch { return NextResponse.json({ success: false, error: 'Неверный формат запроса' } as ApiResponse<null>, { status: 400 }); }

    const parsed = ReviewSchema.safeParse(rawBody);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.path.includes('rating')
        ? 'Рейтинг должен быть от 1 до 5'
        : (parsed.error.issues[0]?.message ?? 'Ошибка валидации');
      return NextResponse.json({ success: false, error: msg } as ApiResponse<null>, { status: 400 });
    }
    const { rating, comment } = parsed.data;
    const photos = parsed.data.photos.filter(isOwnPhotoUrl);

    // Гейт честности: отзыв — только у того, кто реально съездил.
    const bookingCheck = await query(
      `SELECT id FROM operator_bookings
       WHERE user_id = $1
       AND operator_tour_id = $2
       AND booking_status = 'completed'
       AND deleted_at IS NULL
       LIMIT 1`,
      [userId, id]
    );
    if (bookingCheck.rows.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'Вы можете оставить отзыв только после завершения тура',
      } as ApiResponse<null>, { status: 403 });
    }

    // Один отзыв на тур. user_id появился миграцией 832 — если она отстала,
    // запрос упадёт и причина уйдёт наружу словами (catch ниже).
    const existing = await query(
      `SELECT id FROM operator_tour_reviews WHERE user_id = $1 AND tour_id = $2 LIMIT 1`,
      [userId, id]
    );
    if (existing.rows.length > 0) {
      return NextResponse.json({
        success: false,
        error: 'Вы уже оставили отзыв на этот тур',
      } as ApiResponse<null>, { status: 400 });
    }

    const userRow = await query<{ name: string | null }>(
      `SELECT name FROM users WHERE id = $1`, [userId]
    );
    const authorName = userRow.rows[0]?.name?.trim() || 'Гость Ведара';

    // Тип photos берём из схемы, не из предположения — урок operator_tours,
    // где TEXT[] на проде год был jsonb и сохранение молча падало.
    const columnTypes = await getColumnTypes('operator_tour_reviews');
    const result = await query(
      `INSERT INTO operator_tour_reviews (tour_id, user_id, author_name, rating, comment, photos)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, author_name, rating, comment, photos, created_at`,
      [id, userId, authorName, rating, comment || '', valueForColumn(photos, 'photos', columnTypes)]
    );

    return NextResponse.json({
      success: true,
      data: result.rows[0],
      message: 'Отзыв опубликован',
    } as ApiResponse<unknown>);
  } catch (error) {
    // Причина наружу словами: «Ошибка при создании отзыва» без деталей уже
    // прятала несовпадение типов колонок целый сезон.
    const detail = error instanceof Error ? redactPII(error.message).slice(0, 200) : '';
    return NextResponse.json({
      success: false,
      error: detail ? `Не удалось сохранить отзыв: ${detail}` : 'Ошибка при создании отзыва',
    } as ApiResponse<null>, { status: 500 });
  }
}
