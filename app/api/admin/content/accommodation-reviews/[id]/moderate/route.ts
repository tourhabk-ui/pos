import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { transaction } from '@/lib/database';
import { ApiResponse } from '@/types';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.string().uuid('Некорректный ID отзыва') });
const bodySchema = z.object({
  action: z.enum(['hide', 'show'], { errorMap: () => ({ message: 'Действие: hide или show' }) }),
});

/**
 * POST /api/admin/content/accommodation-reviews/[id]/moderate — скрыть/показать
 * отзыв о жилье (is_visible). ВАЖНО: триггер trg_update_accommodation_rating
 * пересчитывает рейтинг только WHEN NEW.is_visible = true, поэтому при СКРЫТИИ
 * он не срабатывает — пересчитываем рейтинг объекта явно в обоих случаях,
 * иначе скрытый отзыв остался бы в средней оценке.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const adminOrResponse = await requireAdmin(request);
  if (adminOrResponse instanceof NextResponse) return adminOrResponse;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ success: false, error: 'Некорректный ID отзыва' } as ApiResponse<null>, { status: 400 });
  }
  let raw: unknown;
  try { raw = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректное тело запроса' } as ApiResponse<null>, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' } as ApiResponse<null>, { status: 400 });
  }

  const reviewId = parsedParams.data.id;
  const nextVisible = parsed.data.action === 'show';

  try {
    const outcome = await transaction(async (client) => {
      const found = await client.query(
        `UPDATE accommodation_reviews SET is_visible = $1, updated_at = NOW()
         WHERE id = $2 RETURNING accommodation_id`,
        [nextVisible, reviewId]
      );
      if (found.rows.length === 0) return { code: 404 as const };

      const accommodationId = (found.rows[0] as { accommodation_id: string }).accommodation_id;

      // Явный пересчёт рейтинга/счётчика по видимым отзывам (страховка от
      // условия триггера WHEN is_visible=true — при скрытии он молчит).
      await client.query(
        `UPDATE accommodations SET
           rating = (SELECT AVG(overall_rating)::DECIMAL(3,2) FROM accommodation_reviews
                     WHERE accommodation_id = $1 AND is_visible = true),
           review_count = (SELECT COUNT(*) FROM accommodation_reviews
                     WHERE accommodation_id = $1 AND is_visible = true),
           updated_at = NOW()
         WHERE id = $1`,
        [accommodationId]
      );
      return { code: 200 as const };
    });

    if (outcome.code === 404) {
      return NextResponse.json({ success: false, error: 'Отзыв не найден' } as ApiResponse<null>, { status: 404 });
    }
    return NextResponse.json({ success: true, data: { isVisible: nextVisible } } as ApiResponse<unknown>);
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка при модерации отзыва' } as ApiResponse<null>, { status: 500 });
  }
}
