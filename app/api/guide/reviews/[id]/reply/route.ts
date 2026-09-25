import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { verifyReviewOwnership } from '@/lib/auth/guide-helpers';
import { requireRole } from '@/lib/auth/middleware';
import { logGuideFailure } from '@/lib/guides/db-failure';
import { z } from 'zod';

const ReviewIdSchema = z.string().uuid('Некорректный идентификатор отзыва');

function badId(): NextResponse {
  return NextResponse.json({ success: false, error: 'Некорректный идентификатор отзыва' } as ApiResponse<null>, { status: 400 });
}

const GuideReplySchema = z.object({
  reply: z.string().min(1, 'Текст ответа не может быть пустым').max(1000, 'Максимальная длина ответа: 1000 символов'),
});

export const dynamic = 'force-dynamic';

/**
 * POST /api/guide/reviews/[id]/reply
 * Reply to a review
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guideOrResponse = await requireRole(request, ['guide', 'admin']);
    if (guideOrResponse instanceof NextResponse) return guideOrResponse;
    const userId = guideOrResponse.userId;

    const { id } = await params;
    if (!ReviewIdSchema.safeParse(id).success) return badId();
    const isOwner = await verifyReviewOwnership(userId, id);
    
    if (!isOwner) {
      return NextResponse.json({
        success: false,
        error: 'Отзыв не найден или у вас нет прав'
      } as ApiResponse<null>, { status: 404 });
    }

    const body = await request.json();
    const parsed = GuideReplySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Некорректные данные' }, { status: 400 });
    }
    const { reply } = parsed.data;

    const result = await query(
      `UPDATE guide_reviews
       SET guide_reply = $1, guide_reply_at = NOW(), updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [reply, id]
    );

    // Уведомление туристу. Отказ не отменяет ответ, но и не глушится:
    // прежде здесь стоял priority='medium', которого CHECK не допускает
    // (low/normal/high/urgent), — INSERT падал 23514 на КАЖДОМ ответе, а
    // пустой catch прятал это полностью.
    try {
      const review = result.rows[0];
      if (review.tourist_id) {
        await query(
          `INSERT INTO notifications (user_id, type, title, message, data, priority)
           VALUES ($1, 'guide_reply', 'Гид ответил на ваш отзыв', $2, $3, 'normal')`,
          [
            review.tourist_id,
            'Гид ответил на ваш отзыв. Посмотрите ответ.',
            JSON.stringify({
              reviewId: id,
              guideId: review.guide_id
            })
          ]
        );
      }
    } catch (notifError) {
      logGuideFailure('уведомление туристу об ответе гида', notifError);
    }

    return NextResponse.json({
      success: true,
      data: result.rows[0],
      message: 'Ответ успешно опубликован'
    } as ApiResponse<unknown>);

  } catch (error) {
    logGuideFailure('POST /api/guide/reviews/[id]/reply', error);
    return NextResponse.json({
      success: false,
      error: 'Ошибка при публикации ответа'
    } as ApiResponse<null>, { status: 500 });
  }
}

/**
 * PUT /api/guide/reviews/[id]/reply
 * Update reply to a review
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guideOrResponse = await requireRole(request, ['guide', 'admin']);
    if (guideOrResponse instanceof NextResponse) return guideOrResponse;
    const userId = guideOrResponse.userId;

    const { id } = await params;
    if (!ReviewIdSchema.safeParse(id).success) return badId();
    const isOwner = await verifyReviewOwnership(userId, id);
    
    if (!isOwner) {
      return NextResponse.json({
        success: false,
        error: 'Отзыв не найден или у вас нет прав'
      } as ApiResponse<null>, { status: 404 });
    }

    const body = await request.json();
    const parsed = GuideReplySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Некорректные данные' }, { status: 400 });
    }
    const { reply } = parsed.data;

    const result = await query(
      `UPDATE guide_reviews
       SET guide_reply = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [reply, id]
    );

    return NextResponse.json({
      success: true,
      data: result.rows[0],
      message: 'Ответ успешно обновлён'
    } as ApiResponse<unknown>);

  } catch (error) {
    logGuideFailure('PUT /api/guide/reviews/[id]/reply', error);
    return NextResponse.json({
      success: false,
      error: 'Ошибка при обновлении ответа'
    } as ApiResponse<null>, { status: 500 });
  }
}

/**
 * DELETE /api/guide/reviews/[id]/reply
 * Delete reply to a review
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guideOrResponse = await requireRole(request, ['guide', 'admin']);
    if (guideOrResponse instanceof NextResponse) return guideOrResponse;
    const userId = guideOrResponse.userId;

    const { id } = await params;
    if (!ReviewIdSchema.safeParse(id).success) return badId();
    const isOwner = await verifyReviewOwnership(userId, id);
    
    if (!isOwner) {
      return NextResponse.json({
        success: false,
        error: 'Отзыв не найден или у вас нет прав'
      } as ApiResponse<null>, { status: 404 });
    }

    await query(
      `UPDATE guide_reviews 
       SET guide_reply = NULL, guide_reply_at = NULL, updated_at = NOW()
       WHERE id = $1`,
      [id]
    );

    return NextResponse.json({
      success: true,
      message: 'Ответ удалён'
    } as ApiResponse<null>);

  } catch (error) {
    logGuideFailure('DELETE /api/guide/reviews/[id]/reply', error);
    return NextResponse.json({
      success: false,
      error: 'Ошибка при удалении ответа'
    } as ApiResponse<null>, { status: 500 });
  }
}
