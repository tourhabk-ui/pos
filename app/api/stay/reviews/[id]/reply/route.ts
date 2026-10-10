/**
 * POST   /api/stay/reviews/[id]/reply — ответить на отзыв гостя (или поправить ответ)
 * DELETE /api/stay/reviews/[id]/reply — убрать ответ
 *
 * CRM, хвосты фазы 1 (#2325); колонки — миграция 1208. Владение — в самом
 * UPDATE: объект отзыва принадлежит партнёру вошедшего владельца. Гость с
 * аккаунтом получает уведомление; отказ его записи ответ не отменяет, но
 * называется в логе.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { getStayPartnerId, requireStayOwner, stayCheckUnavailableResponse, StayCheckUnavailableError } from '@/lib/auth/stay-helpers';

export const dynamic = 'force-dynamic';

export const STAY_REPLY_MAX = 2000;

const ReplySchema = z.object({
  reply: z.string().trim().min(1, 'Текст ответа не может быть пустым').max(STAY_REPLY_MAX, `Ответ — не длиннее ${STAY_REPLY_MAX} символов`),
});

const Id = z.string().uuid();

type Ctx = { params: Promise<{ id: string }> };

const NOT_FOUND = { success: false, error: 'Отзыв не найден' } as const;

/** Объект отзыва — партнёра владельца; предикат один на оба метода. */
const OWNED = `r.accommodation_id = a.id AND a.partner_id = $2`;

function failed(err: unknown, what: string): NextResponse {
  const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
  console.error(`[stay-reviews] ${what}, SQLSTATE`, code);
  return NextResponse.json({ success: false, error: 'Ответ не сохранён, попробуйте позже' }, { status: 503 });
}

async function ownerPartner(request: NextRequest): Promise<string | NextResponse> {
  const auth = await requireStayOwner(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const partnerId = await getStayPartnerId(auth.userId);
    return partnerId ?? NextResponse.json({ success: false, error: 'Профиль владельца жилья не найден' }, { status: 404 });
  } catch (err) {
    if (err instanceof StayCheckUnavailableError) return stayCheckUnavailableResponse();
    throw err;
  }
}

export async function POST(request: NextRequest, { params }: Ctx) {
  const partnerId = await ownerPartner(request);
  if (partnerId instanceof NextResponse) return partnerId;

  const id = Id.safeParse((await params).id);
  if (!id.success) return NextResponse.json(NOT_FOUND, { status: 404 });

  const body: unknown = await request.json().catch(() => null);
  const parsed = ReplySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Некорректные данные' }, { status: 400 });
  }

  let saved: { id: string; user_id: string | null; owner_reply: string; owner_reply_at: Date } | undefined;
  try {
    ({ rows: [saved] } = await query<{ id: string; user_id: string | null; owner_reply: string; owner_reply_at: Date }>(
      `UPDATE accommodation_reviews r
          SET owner_reply = $3, owner_reply_at = NOW(), updated_at = NOW()
         FROM accommodations a
        WHERE r.id = $1::uuid AND ${OWNED}
        RETURNING r.id, r.user_id, r.owner_reply, r.owner_reply_at`,
      [id.data, partnerId, parsed.data.reply],
    ));
  } catch (err) {
    return failed(err, 'ответ на отзыв не сохранён');
  }
  if (!saved) return NextResponse.json(NOT_FOUND, { status: 404 });

  if (saved.user_id) {
    try {
      await query(
        `INSERT INTO notifications (user_id, type, title, message, priority)
         VALUES ($1, 'review_reply', 'Получен ответ на ваш отзыв', 'Хозяин жилья ответил на ваш отзыв', 'normal')`,
        [saved.user_id],
      );
    } catch (err) {
      const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
      console.error('[stay-reviews] уведомление гостю не записано, SQLSTATE', code);
    }
  }

  return NextResponse.json({
    success: true,
    data: { id: saved.id, ownerReply: saved.owner_reply, ownerReplyAt: new Date(saved.owner_reply_at).toISOString() },
  });
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  const partnerId = await ownerPartner(request);
  if (partnerId instanceof NextResponse) return partnerId;

  const id = Id.safeParse((await params).id);
  if (!id.success) return NextResponse.json(NOT_FOUND, { status: 404 });

  try {
    const { rowCount } = await query(
      `UPDATE accommodation_reviews r
          SET owner_reply = NULL, owner_reply_at = NULL, updated_at = NOW()
         FROM accommodations a
        WHERE r.id = $1::uuid AND ${OWNED} AND r.owner_reply IS NOT NULL`,
      [id.data, partnerId],
    );
    if (!rowCount) return NextResponse.json(NOT_FOUND, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (err) {
    return failed(err, 'ответ на отзыв не удалён');
  }
}
