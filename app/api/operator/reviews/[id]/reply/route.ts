/**
 * POST   /api/operator/reviews/[id]/reply — ответить на отзыв о своём туре (или поправить ответ)
 * DELETE /api/operator/reviews/[id]/reply — убрать ответ
 *
 * Отзыв — operator_tour_reviews (миграции 087, 832, 878), ответ — колонки
 * operator_reply / operator_reply_at. Владение — в самом UPDATE: тур отзыва
 * принадлежит партнёру вошедшего оператора.
 *
 * Правка 10.10 (CRM, хвосты фазы 1): у роута появился экран
 * (/hub/operator/reviews), и вместе с ним сняты три дефекта:
 *  - уведомление автору писалось вне try и без проверки user_id — у отзыва
 *    без аккаунта (832: user_id nullable) INSERT падал, и оператор получал
 *    500 уже ПОСЛЕ сохранённого ответа;
 *  - catch глушил отказ без лога (§4.0);
 *  - длина ответа не была ограничена.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { requireOperator } from '@/lib/auth/middleware';

export const dynamic = 'force-dynamic';

export const REPLY_MAX = 2000;

const ReplySchema = z.object({
  reply: z.string().trim().min(1, 'Текст ответа не может быть пустым').max(REPLY_MAX, `Ответ — не длиннее ${REPLY_MAX} символов`),
});

const Id = z.coerce.number().int().positive();

type Ctx = { params: Promise<{ id: string }> };

const NOT_FOUND = { success: false, error: 'Отзыв не найден' } as const;

function failed(err: unknown, what: string): NextResponse {
  const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
  console.error(`[operator-reviews] ${what}, SQLSTATE`, code);
  return NextResponse.json({ success: false, error: 'Ответ не сохранён, попробуйте позже' }, { status: 503 });
}

/** Тур отзыва принадлежит партнёру этого оператора — предикат один на оба метода. */
const OWNED = `r.tour_id = t.id AND t.operator_id = p.id AND p.user_id = $2 AND t.deleted_at IS NULL`;

interface SavedRow {
  id: number;
  user_id: string | null;
  operator_reply: string;
  operator_reply_at: Date;
}

export async function POST(request: NextRequest, { params }: Ctx) {
  const auth = await requireOperator(request);
  if (auth instanceof NextResponse) return auth;

  const id = Id.safeParse((await params).id);
  if (!id.success) return NextResponse.json(NOT_FOUND, { status: 404 });

  const body: unknown = await request.json().catch(() => null);
  const parsed = ReplySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Некорректные данные' }, { status: 400 });
  }

  let saved: SavedRow | undefined;
  try {
    ({ rows: [saved] } = await query<SavedRow>(
      `UPDATE operator_tour_reviews r
          SET operator_reply = $3, operator_reply_at = NOW(), updated_at = NOW()
         FROM operator_tours t, partners p
        WHERE r.id = $1 AND ${OWNED}
        RETURNING r.id, r.user_id, r.operator_reply, r.operator_reply_at`,
      [id.data, auth.userId, parsed.data.reply],
    ));
  } catch (err) {
    return failed(err, 'ответ на отзыв не сохранён');
  }
  if (!saved) return NextResponse.json(NOT_FOUND, { status: 404 });

  // Уведомление автору — только если у отзыва есть аккаунт; отказ записи не
  // отменяет сохранённый ответ, но называется в логе.
  if (saved.user_id) {
    try {
      await query(
        `INSERT INTO notifications (user_id, type, title, message, priority)
         VALUES ($1, 'review_reply', 'Получен ответ на ваш отзыв', 'Оператор ответил на ваш отзыв о туре', 'normal')`,
        [saved.user_id],
      );
    } catch (err) {
      const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
      console.error('[operator-reviews] уведомление автору не записано, SQLSTATE', code);
    }
  }

  return NextResponse.json({
    success: true,
    data: { id: saved.id, operatorReply: saved.operator_reply, operatorReplyAt: new Date(saved.operator_reply_at).toISOString() },
  });
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  const auth = await requireOperator(request);
  if (auth instanceof NextResponse) return auth;

  const id = Id.safeParse((await params).id);
  if (!id.success) return NextResponse.json(NOT_FOUND, { status: 404 });

  try {
    const { rowCount } = await query(
      `UPDATE operator_tour_reviews r
          SET operator_reply = NULL, operator_reply_at = NULL, updated_at = NOW()
         FROM operator_tours t, partners p
        WHERE r.id = $1 AND ${OWNED} AND r.operator_reply IS NOT NULL`,
      [id.data, auth.userId],
    );
    if (!rowCount) return NextResponse.json(NOT_FOUND, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (err) {
    return failed(err, 'ответ на отзыв не удалён');
  }
}
