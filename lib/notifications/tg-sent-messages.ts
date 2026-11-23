/**
 * message_id из ответа Bot API.
 *
 * sendMessage и sendPhoto возвращают одно сообщение, sendMediaGroup — массив.
 * Числовой chat.id берём оттуда же: в запрос уходит и @username, а вебхук
 * channel_post приносит id числом. Без пары (чат, сообщение) репостер не
 * отличит свой пост от чужого.
 */

export interface TgSentMessage {
  chatId: number;
  messageId: number;
}

export interface TgDeliveryIds {
  messageIds: number[];
  messages: TgSentMessage[];
}

export function noTgIds(): TgDeliveryIds {
  return { messageIds: [], messages: [] };
}

export function tgDeliveryIds(messages: readonly TgSentMessage[]): TgDeliveryIds {
  return {
    messages: [...messages],
    messageIds: messages.map((m) => m.messageId),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
}

/** Успешный result: одно сообщение или массив (альбом). Чужой формат — пусто. */
export function sentMessagesFromTelegramBody(body: unknown): TgSentMessage[] {
  const root = asRecord(body);
  if (!root) return [];
  const result = root.result;
  const list = Array.isArray(result) ? result : result != null ? [result] : [];
  const out: TgSentMessage[] = [];
  for (const item of list) {
    const rec = asRecord(item);
    if (!rec) continue;
    const messageId = rec.message_id;
    const chatId = asRecord(rec.chat)?.id;
    if (typeof messageId !== 'number' || !Number.isSafeInteger(messageId)) continue;
    if (typeof chatId !== 'number' || !Number.isSafeInteger(chatId)) continue;
    out.push({ chatId, messageId });
  }
  return out;
}
