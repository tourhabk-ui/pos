/**
 * Сообщение администратора в MAX — фаза 1: опознан, отвечает командами
 * чтения (lib/max/admin-read). Модели здесь нет: ответы детерминированные, и
 * ПД туристов из броней и заявок не уходят ни в модель, ни в историю
 * переписки.
 *
 * Ответ с ПД — через sendPdAlert с явным адресом (личный диалог
 * администратора): без отката на общий чат платформы и без заглушки в
 * Telegram. Не доставился — администратор узнаёт об этом в том же чате
 * текстом без ПД.
 */

import { sendPdAlert } from '@/lib/notifications/pd-alert';
import { escapeHtml } from '@/lib/text/escape-html';
import { ADMIN_HELP_TEXT, adminCommandOf, adminReplyFor } from '@/lib/max/admin-read';

export const ADMIN_CHAT_TEXT = {
  textOnly: 'Как администратор принимаю в MAX только текст: фото, голос и номера здесь не обрабатываю.',
  notUnderstood: `Не понял команду.\n\n${ADMIN_HELP_TEXT}`,
  pdNotDelivered: 'Ответ с контактами туристов не доставлен в MAX — откройте раздел в админке на vedarai.ru.',
} as const;

export function adminGreeting(name: string | null): string {
  return `Вы подключены как администратор Ведара${name ? `, ${escapeHtml(name)}` : ''}. `
    + 'Права проверяются на каждом сообщении.\n\n' + ADMIN_HELP_TEXT;
}

/**
 * Ответить администратору. `reply` — обычный ответ в чат (без ПД); ответ с
 * ПД уходит через sendPdAlert в тот же чат.
 */
export async function handleAdminMessage(opts: {
  text: string;
  name: string | null;
  chatId: number;
  reply: (chatId: number, text: string) => Promise<void>;
  nowMs?: number;
}): Promise<void> {
  const { text, name, chatId, reply } = opts;
  if (/^\/start\b/i.test(text.trim())) {
    await reply(chatId, adminGreeting(name));
    return;
  }
  const cmd = adminCommandOf(text);
  if (cmd === null) {
    await reply(chatId, ADMIN_CHAT_TEXT.notUnderstood);
    return;
  }
  const res = await adminReplyFor(cmd, opts.nowMs);
  if (!res.pd) {
    await reply(chatId, res.text);
    return;
  }
  const sent = await sendPdAlert({
    text: res.text,
    stub: 'Ответ администратору в MAX не доставлен.',
    to: { maxChatId: chatId, telegramChatId: null },
  });
  if (!sent.delivered) {
    console.error('[max/admin] ответ с ПД не доставлен:', sent.reason);
    await reply(chatId, ADMIN_CHAT_TEXT.pdNotDelivered);
  }
}
