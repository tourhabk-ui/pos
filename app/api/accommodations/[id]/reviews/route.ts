import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { requireAuth } from '@/lib/auth/middleware';
import { containsProfanity } from '@/lib/services/profanity-filter';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid('Некорректный ID объекта') });

const rating = z.coerce.number().int().min(1).max(5);
const bodySchema = z.object({
  bookingId: z.string().uuid('Некорректный ID брони'),
  overallRating: rating,
  cleanlinessRating: rating.optional(),
  serviceRating: rating.optional(),
  locationRating: rating.optional(),
  valueRating: rating.optional(),
  title: z.string().trim().max(255).optional(),
  comment: z.string().trim().max(5000).optional(),
});

/**
 * POST /api/accommodations/[id]/reviews — гость оставляет отзыв о жилье.
 * Защита от накрутки: отзыв возможен только при наличии ЗАВЕРШЁННОЙ
 * (status='completed') брони этого объекта у гостя, и только один отзыв
 * на бронь. Рейтинг пересчитывается триггером trg_update_accommodation_rating.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAuth(request);
  if (authResult instanceof NextResponse) return authResult;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ success: false, error: 'Некорректный ID объекта' }, { status: 400 });
  }
  const accommodationId = parsedParams.data.id;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Некорректное тело запроса' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: 'Неверные данные отзыва', details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const b = parsed.data;
  const userId = authResult.userId;

  try {
    // Мат — единственная проверка на входе; fail-open (недоступность фильтра не блокирует)
    if (b.comment) {
      const profane = await containsProfanity(b.comment);
      if (profane === true) {
        return NextResponse.json(
          { success: false, error: 'Отзыв содержит недопустимую лексику. Пожалуйста, перефразируйте.' },
          { status: 422 }
        );
      }
    }

    // Завершённая бронь именно этого объекта у этого гостя — иначе накрутка
    const completed = await query(
      `SELECT 1 FROM accommodation_bookings
       WHERE id = $1 AND user_id = $2 AND accommodation_id = $3 AND status = 'completed'
       LIMIT 1`,
      [b.bookingId, userId, accommodationId]
    );
    if (completed.rows.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Отзыв можно оставить только после завершённого проживания' },
        { status: 403 }
      );
    }

    // Один отзыв на бронь. Атомарно (WHERE NOT EXISTS в самом INSERT), т.к.
    // UNIQUE на booking_id в схеме нет — check-then-insert словил бы гонку
    // двух параллельных запросов и удвоил отзыв (накрутка рейтинга).
    const result = await query<{ id: string; created_at: string }>(
      `INSERT INTO accommodation_reviews
         (user_id, accommodation_id, booking_id, overall_rating,
          cleanliness_rating, service_rating, location_rating, value_rating,
          title, comment, is_verified, is_visible)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, true
       WHERE NOT EXISTS (
         SELECT 1 FROM accommodation_reviews WHERE booking_id = $3
       )
       RETURNING id, created_at`,
      [
        userId, accommodationId, b.bookingId, b.overallRating,
        b.cleanlinessRating ?? null, b.serviceRating ?? null,
        b.locationRating ?? null, b.valueRating ?? null,
        b.title ?? null, b.comment ?? null,
      ]
    );

    if (result.rows.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Вы уже оставляли отзыв по этой брони' },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { success: true, data: { id: result.rows[0].id, createdAt: result.rows[0].created_at } },
      { status: 201 }
    );
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка при сохранении отзыва' }, { status: 500 });
  }
}
