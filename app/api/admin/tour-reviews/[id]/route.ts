import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { query } from '@/lib/database';
import { settleTourReviewEco } from '@/lib/eco/review-eco';

export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ id: z.string().regex(/^\d+$/, 'Некорректный ID отзыва') });

/**
 * Скрыть отзыв — решение модератора с записанной причиной (миграция 878:
 * «пустая причина — не решение, а мнение»). Вернуть — без причины.
 */
const BodySchema = z.discriminatedUnion('hidden', [
  z.object({
    hidden: z.literal(true),
    reason: z.string().trim().min(8, 'Причина скрытия — не короче 8 символов'),
  }),
  z.object({ hidden: z.literal(false) }),
]);

/**
 * PATCH /api/admin/tour-reviews/[id] — скрыть или вернуть отзыв о туре.
 *
 * Вместе с видимостью сводятся эко за отзыв (решение владельца 24.09,
 * «списывай при скрытии»): скрыт — начисленное за отзыв и фото списывается,
 * возвращён — восстанавливается (lib/eco/review-eco.ts). Рейтинг тура
 * пересчитывается по видимым отзывам — тем же выражением, что при публикации.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin(request);
  if (admin instanceof NextResponse) return admin;

  const p = ParamsSchema.safeParse(await params);
  if (!p.success) return NextResponse.json({ success: false, error: 'Некорректный ID отзыва' }, { status: 400 });
  const b = BodySchema.safeParse(await request.json().catch(() => null));
  if (!b.success) {
    return NextResponse.json({ success: false, error: b.error.issues[0]?.message ?? 'Некорректные данные' }, { status: 400 });
  }
  const hidden = b.data.hidden;
  const reason = b.data.hidden ? b.data.reason : null;

  try {
    const upd = await query<{ id: string; tour_id: string; user_id: string | null; photo_count: number }>(
      `UPDATE operator_tour_reviews
          SET is_hidden = $2, hidden_reason = $3, updated_at = NOW()
        WHERE id = $1::bigint
        RETURNING id::text, tour_id::text, user_id::text, COALESCE(array_length(photos, 1), 0) AS photo_count`,
      [p.data.id, hidden, reason],
    );
    const row = upd.rows[0];
    if (!row) return NextResponse.json({ success: false, error: 'Отзыв не найден' }, { status: 404 });

    await query(
      `UPDATE operator_tours SET
         rating = (SELECT ROUND(AVG(rating)::numeric, 1) FROM operator_tour_reviews r
                    WHERE r.tour_id = $1 AND r.is_hidden = FALSE),
         review_count = (SELECT COUNT(*) FROM operator_tour_reviews r
                          WHERE r.tour_id = $1 AND r.is_hidden = FALSE),
         updated_at = NOW()
       WHERE id = $1`,
      [row.tour_id],
    );

    const eco = await settleTourReviewEco({
      id: row.id,
      userId: row.user_id,
      isHidden: hidden,
      hasPhotos: Number(row.photo_count) > 0,
    });

    return NextResponse.json({
      success: true,
      data: { id: row.id, hidden, eco },
      message: hidden
        ? (eco.shortfall > 0
            ? `Отзыв скрыт. Списано ${-eco.changedUser} эко; ещё ${eco.shortfall} уже потрачены — списать нечего`
            : `Отзыв скрыт${eco.changedUser < 0 ? `, списано ${-eco.changedUser} эко` : ''}`)
        : `Отзыв снова виден${eco.changedUser > 0 ? `, возвращено ${eco.changedUser} эко` : ''}`,
    });
  } catch (err) {
    console.error('[admin/tour-reviews] модерация не записана:', err);
    return NextResponse.json({ success: false, error: 'Не удалось изменить отзыв' }, { status: 500 });
  }
}
