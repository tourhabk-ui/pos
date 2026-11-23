/**
 * Свои посты канала, которые платформа сама зеркалит в MAX.
 *
 * postToAllChannels и ручной пост с toMax уже шлют текст в MAX. Репостер
 * получает тот же channel_post и прислал бы его второй раз. Пара
 * (tg_chat_id, message_id) пишется сразу после ответа Telegram и до MAX:
 * вебхук может прийти, как только сообщение создано.
 *
 * В строке только числа. Текст поста сюда не кладётся: в канале бывают
 * телефоны, и журналу они не нужны.
 */

import { query } from '@/lib/database';
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import type { TgSentMessage } from '@/lib/notifications/tg-sent-messages';

function deduped(messages: readonly TgSentMessage[]): TgSentMessage[] {
  const seen = new Set<string>();
  const rows: TgSentMessage[] = [];
  for (const m of messages) {
    if (!Number.isSafeInteger(m.chatId) || !Number.isSafeInteger(m.messageId)) continue;
    const key = `${m.chatId}:${m.messageId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(m);
  }
  return rows;
}

/**
 * Записать пары до отправки в MAX. Пустой список — писать нечего, это не отказ.
 * Отказ базы — { ok: false }: вызывающий всё равно шлёт в MAX сам, а репостер
 * при непроверенной паре не подтверждает приём (503), чтобы не задвоить.
 */
export async function recordOwnChannelPosts(
  messages: readonly TgSentMessage[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const rows = deduped(messages);
  if (rows.length === 0) return { ok: true };
  try {
    await query(
      `INSERT INTO tg_channel_own_posts (tg_chat_id, message_id)
       SELECT u.chat_id::bigint, u.message_id::bigint
         FROM unnest($1::text[], $2::text[]) AS u(chat_id, message_id)
       ON CONFLICT (tg_chat_id, message_id) DO NOTHING`,
      [rows.map((r) => String(r.chatId)), rows.map((r) => String(r.messageId))],
    );
    return { ok: true };
  } catch (err) {
    logSwallowedFailure('channel/own-posts', 'запись своих постов канала', err);
    return { ok: false, error: err instanceof Error ? err.message : 'запись не удалась' };
  }
}

/**
 * Есть ли пара в журнале.
 * true — свой пост, репостер не шлёт в MAX.
 * false — чужой (или id не число): пересылать.
 * null — базу спросить не удалось. Это не «чужой»: вызывающий не подтверждает приём.
 */
export async function ownChannelPostRecorded(
  chatId: number | null | undefined,
  messageId: number | null | undefined,
): Promise<boolean | null> {
  if (typeof chatId !== 'number' || typeof messageId !== 'number') return false;
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId)) return false;
  try {
    const res = await query<{ hit: number }>(
      `SELECT 1 AS hit
         FROM tg_channel_own_posts
        WHERE tg_chat_id = $1::bigint
          AND message_id = $2::bigint
        LIMIT 1`,
      [String(chatId), String(messageId)],
    );
    return res.rows.length > 0;
  } catch (err) {
    logSwallowedFailure('reposter/own-post', 'проверка своего поста канала', err);
    return null;
  }
}
