import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { verifyReviewOwnership } from '@/lib/auth/guide-helpers';
import { requireRole } from '@/lib/auth/middleware';
import { logGuideFailure } from '@/lib/guides/db-failure';
import {
  GuideReplySchema, notifyTouristOfReply, writeGuideReviewReply, type ReplyAction, type RunSql,
} from '@/lib/guides/review-reply';
import { z } from 'zod';

/**
 * Ответ гида на отзыв: POST — опубликовать, PUT — изменить, DELETE — убрать.
 *
 * Запись — общей функцией `writeGuideReviewReply` (lib/guides/review-reply):
 * ту же зовёт кнопка «Опубликовать» в чате кабинета, и лимит, SQL и
 * уведомление туристу у двух дверей одни.
 */

const ReviewIdSchema = z.string().uuid('Некорректный идентификатор отзыва');

function badId(): NextResponse {
  return NextResponse.json({ success: false, error: 'Некорректный идентификатор отзыва' } as ApiResponse<null>, { status: 400 });
}

function notYours(): NextResponse {
  return NextResponse.json({
    success: false,
    error: 'Отзыв не найден или у вас нет прав'
  } as ApiResponse<null>, { status: 404 });
}

export const dynamic = 'force-dynamic';

const run: RunSql = (text, params) => query(text, params);

const FAILED: Record<ReplyAction, string> = {
  post: 'Ошибка при публикации ответа',
  update: 'Ошибка при обновлении ответа',
  delete: 'Ошибка при удалении ответа',
};

const DONE: Record<ReplyAction, string> = {
  post: 'Ответ успешно опубликован',
  update: 'Ответ успешно обновлён',
  delete: 'Ответ удалён',
};

async function handle(
  request: NextRequest,
  params: Promise<{ id: string }>,
  action: ReplyAction,
): Promise<NextResponse> {
  const method = action === 'post' ? 'POST' : action === 'update' ? 'PUT' : 'DELETE';
  try {
    const guideOrResponse = await requireRole(request, ['guide', 'admin']);
    if (guideOrResponse instanceof NextResponse) return guideOrResponse;
    const userId = guideOrResponse.userId;

    const { id } = await params;
    if (!ReviewIdSchema.safeParse(id).success) return badId();
    if (!(await verifyReviewOwnership(userId, id))) return notYours();

    let reply: string | null = null;
    if (action !== 'delete') {
      const parsed = GuideReplySchema.safeParse(await request.json());
      if (!parsed.success) {
        return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Некорректные данные' }, { status: 400 });
      }
      reply = parsed.data.reply;
    }

    const written = await writeGuideReviewReply(run, { owner: { userId }, reviewId: id, action, reply });
    if (written.outcome === 'invalid') {
      return NextResponse.json({ success: false, error: written.error }, { status: 400 });
    }
    if (written.outcome === 'not_found') return notYours();
    if (action === 'post') await notifyTouristOfReply(run, written.review, id);

    if (action === 'delete') {
      return NextResponse.json({ success: true, message: DONE.delete } as ApiResponse<null>);
    }
    return NextResponse.json({
      success: true,
      data: written.review,
      message: DONE[action],
    } as ApiResponse<unknown>);
  } catch (error) {
    logGuideFailure(`${method} /api/guide/reviews/[id]/reply`, error);
    return NextResponse.json({
      success: false,
      error: FAILED[action],
    } as ApiResponse<null>, { status: 500 });
  }
}

/** POST /api/guide/reviews/[id]/reply — опубликовать ответ. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(request, params, 'post');
}

/** PUT /api/guide/reviews/[id]/reply — изменить ответ. */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(request, params, 'update');
}

/** DELETE /api/guide/reviews/[id]/reply — убрать ответ. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handle(request, params, 'delete');
}
