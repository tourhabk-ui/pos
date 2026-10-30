/**
 * Ответ гида на отзыв — одна запись для сайта и чата кабинета (слово
 * владельца 30.10: «гид должен полностью управлять своей ролью из MAX»).
 *
 * Пишут двое: `POST/PUT/DELETE /api/guide/reviews/[id]/reply` (кабинет на
 * сайте) и кнопка «Опубликовать» / «Удалить» в чате (lib/guides/chat-role).
 * SQL, лимит длины и уведомление туристу — здесь, в одном месте: ответ виден
 * туристам на странице гида, и правило «что можно опубликовать» у двух дверей
 * разойтись не должно.
 *
 * Чей отзыв — условие в самом UPDATE (`guide_id` карточки гида или карточек
 * аккаунта), а не только проверка перед ним: чужой отзыв — «не найдено», ни
 * строки не тронуто.
 *
 * Текст хранится как написан; экранирует тот, кто показывает (страница —
 * React, чат — escapeHtml).
 */

import { z } from 'zod';
import { logGuideFailure } from '@/lib/guides/db-failure';

/** Предел длины ответа — один на сайт и чат. */
export const GUIDE_REPLY_MAX = 1000;

export const GuideReplySchema = z.object({
  reply: z.string().min(1, 'Текст ответа не может быть пустым').max(GUIDE_REPLY_MAX, `Максимальная длина ответа: ${GUIDE_REPLY_MAX} символов`),
});

/** Исполнитель SQL: `query` из lib/database или клиент транзакции. */
export type RunSql = (text: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;

/** Чей отзыв: карточка гида (чат) или любая карточка аккаунта (сайт, как verifyReviewOwnership). */
export type ReplyOwner = { partnerId: string } | { userId: string };

export type ReplyAction = 'post' | 'update' | 'delete';

function ownerSql(owner: ReplyOwner, idx: number): { sql: string; value: string } {
  return 'partnerId' in owner
    ? { sql: `guide_id = $${idx}::uuid`, value: owner.partnerId }
    : { sql: `guide_id IN (SELECT id FROM partners WHERE user_id = $${idx}::uuid)`, value: owner.userId };
}

/** SQL записи: POST ставит время ответа, PUT его не трогает, DELETE снимает оба поля. */
export function replySql(action: ReplyAction, owner: ReplyOwner): { text: string; params: (reply: string | null, reviewId: string) => unknown[] } {
  if (action === 'delete') {
    const o = ownerSql(owner, 2);
    return {
      text: `UPDATE guide_reviews
         SET guide_reply = NULL, guide_reply_at = NULL, updated_at = NOW()
       WHERE id = $1::uuid AND ${o.sql}
       RETURNING *`,
      params: (_reply, reviewId) => [reviewId, o.value],
    };
  }
  const o = ownerSql(owner, 3);
  const at = action === 'post' ? ', guide_reply_at = NOW()' : '';
  return {
    text: `UPDATE guide_reviews
         SET guide_reply = $1${at}, updated_at = NOW()
       WHERE id = $2::uuid AND ${o.sql}
       RETURNING *`,
    params: (reply, reviewId) => [reply, reviewId, o.value],
  };
}

export type ReplyWrite =
  | { outcome: 'written'; review: Record<string, unknown> }
  | { outcome: 'not_found' }
  | { outcome: 'invalid'; error: string };

/**
 * Записать ответ. Текст проверяется той же схемой, что форма сайта; отказ
 * базы — исключение (вызывающий отвечает «не сохранилось» и пишет в лог).
 */
export async function writeGuideReviewReply(run: RunSql, input: {
  owner: ReplyOwner;
  reviewId: string;
  action: ReplyAction;
  reply?: string | null;
}): Promise<ReplyWrite> {
  let reply: string | null = null;
  if (input.action !== 'delete') {
    const parsed = GuideReplySchema.safeParse({ reply: input.reply ?? '' });
    if (!parsed.success) return { outcome: 'invalid', error: parsed.error.issues[0]?.message ?? 'Некорректный текст ответа' };
    reply = parsed.data.reply;
  }
  const q = replySql(input.action, input.owner);
  const { rows } = await run(q.text, q.params(reply, input.reviewId));
  const review = rows[0];
  return review ? { outcome: 'written', review } : { outcome: 'not_found' };
}

/**
 * Уведомление туристу о новом ответе (только первый ответ — POST). Отказ не
 * отменяет ответ, но и не глушится. Зовётся ПОСЛЕ фиксации записи: в
 * транзакции упавший INSERT уведомления отменил бы и сам ответ.
 */
export async function notifyTouristOfReply(run: RunSql, review: Record<string, unknown>, reviewId: string): Promise<void> {
  const touristId = typeof review.tourist_id === 'string' ? review.tourist_id : null;
  if (!touristId) return;
  try {
    await run(
      `INSERT INTO notifications (user_id, type, title, message, data, priority)
       VALUES ($1, 'guide_reply', 'Гид ответил на ваш отзыв', $2, $3, 'normal')`,
      [
        touristId,
        'Гид ответил на ваш отзыв. Посмотрите ответ.',
        JSON.stringify({ reviewId, guideId: review.guide_id }),
      ],
    );
  } catch (notifError) {
    logGuideFailure('уведомление туристу об ответе гида', notifError);
  }
}
