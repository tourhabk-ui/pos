import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { query } from '@/lib/database';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/tour-reviews — отзывы о турах (operator_tour_reviews) для
 * модерации. Своя поверхность, потому что /api/admin/content/reviews
 * работает со старой таблицей `reviews`, а туристы пишут сюда (миграция 878):
 * скрыть отзыв о туре до 24.09 было нечем, кроме SQL руками.
 */
const QuerySchema = z.object({
  filter: z.enum(['all', 'visible', 'hidden']).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export async function GET(request: NextRequest) {
  const admin = await requireAdmin(request);
  if (admin instanceof NextResponse) return admin;

  const parsed = QuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Некорректные параметры' }, { status: 400 });
  }
  const { filter, limit } = parsed.data;
  const where = filter === 'visible' ? 'WHERE r.is_hidden = FALSE'
    : filter === 'hidden' ? 'WHERE r.is_hidden = TRUE' : '';

  try {
    const { rows } = await query(
      `SELECT r.id::text, r.tour_id::text, t.title AS tour_title, r.author_name,
              r.rating, r.comment, COALESCE(array_length(r.photos, 1), 0) AS photo_count,
              r.is_hidden, r.hidden_reason, r.created_at
         FROM operator_tour_reviews r
         JOIN operator_tours t ON t.id = r.tour_id
         ${where}
        ORDER BY r.created_at DESC
        LIMIT $1`,
      [limit],
    );
    return NextResponse.json({ success: true, data: rows });
  } catch (err) {
    console.error('[admin/tour-reviews] список не прочитан:', err);
    return NextResponse.json({ success: false, error: 'Не удалось загрузить отзывы' }, { status: 500 });
  }
}
