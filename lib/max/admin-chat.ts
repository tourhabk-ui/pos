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
import { withSosBlock } from '@/lib/safety/sos-detector';
import { ADMIN_HELP_TEXT, adminCommandOf, adminReplyFor } from '@/lib/max/admin-read';
import { adminMenu } from '@/lib/roles/role-menu';
import { menuRows, type MenuButton } from '@/lib/roles/chat-menu';
import { handleAdminDatesText } from '@/lib/max/admin-dates';

export const ADMIN_CHAT_TEXT = {
  // Голос и фото здесь не разбираются, а в них может быть беда: строка 112 —
  // в самом отказе.
  textOnly: 'Как администратор принимаю в MAX только текст: фото, голос и номера здесь не обрабатываю. В беде — звоните 112.',
  notUnderstood: `Не понял команду.\n\n${ADMIN_HELP_TEXT}`,
  pdNotDelivered: 'Ответ с контактами туристов не доставлен в MAX — откройте раздел в админке на vedarai.ru.',
  /** Подпись кнопок действий, ушедших следом за списком с ПД. */
  actionsAfterList: 'Открыть заявку из списка выше:',
} as const;

export function adminGreeting(name: string | null): string {
  return `Вы подключены как администратор Ведара${name ? `, ${escapeHtml(name)}` : ''}. `
    + 'Права проверяются на каждом сообщении.\n\n' + ADMIN_HELP_TEXT;
}

/**
 * Ответить администратору. `reply` — обычный ответ в чат (без ПД) со строкой
 * меню; `replyButtons` — ответ без ПД со своими строками кнопок (строка меню
 * в них уже есть). Ответ с ПД уходит через sendPdAlert в тот же чат, его
 * кнопки действий («Заявка N») — следом отдельным сообщением без ПД.
 */
export async function handleAdminMessage(opts: {
  text: string;
  name: string | null;
  chatId: number;
  reply: (chatId: number, text: string) => Promise<void>;
  replyButtons: (chatId: number, text: string, rows: MenuButton[][]) => Promise<void>;
  /** Аккаунт администратора этого сообщения (роут проверил роль на нём): кто открывает даты. */
  adminUserId: string;
  nowMs?: number;
}): Promise<void> {
  const { text, name, chatId } = opts;
  // Беду классификатор отдаёт Кузьмичу туриста раньше этой функции; если она
  // дошла сюда (дело CRM в той же фразе), ответ всё равно несёт блок 112.
  const reply = (id: number, body: string) => opts.reply(id, withSosBlock(body, text).text);
  if (/^\/start\b/i.test(text.trim())) {
    await reply(chatId, adminGreeting(name));
    return;
  }
  // Даты за оператора (фаза 2б, 07.11) — раньше команд: «открой … на Горелый,
  // 6 мест» — фраза, а не команда «даты». Не фраза про даты — дальше команды.
  const dates = await handleAdminDatesText({ adminUserId: opts.adminUserId, chatId, text, nowMs: opts.nowMs });
  if (dates) {
    await opts.replyButtons(chatId, withSosBlock(dates.text, text).text, dates.buttons);
    return;
  }
  const cmd = adminCommandOf(text);
  if (cmd === null) {
    await reply(chatId, ADMIN_CHAT_TEXT.notUnderstood);
    return;
  }
  const res = await adminReplyFor(cmd, opts.nowMs);
  const actions = res.buttons ?? [];
  if (!res.pd) {
    if (actions.length) await opts.replyButtons(chatId, withSosBlock(res.text, text).text, [...actions, ...menuRows(adminMenu())]);
    else await reply(chatId, res.text);
    return;
  }
  const sent = await sendPdAlert({
    text: withSosBlock(res.text, text).text,
    stub: 'Ответ администратору в MAX не доставлен.',
    buttons: adminMenu(),
    to: { maxChatId: chatId, telegramChatId: null },
  });
  if (!sent.delivered) {
    console.error('[max/admin] ответ с ПД не доставлен:', sent.reason);
    await reply(chatId, ADMIN_CHAT_TEXT.pdNotDelivered);
    return;
  }
  // Кнопки действий — следом и без ПД: список с контактами уходит через
  // sendPdAlert, а его кнопки в MAX встают по одной в строку под меню.
  if (actions.length) await opts.replyButtons(chatId, ADMIN_CHAT_TEXT.actionsAfterList, [...actions, ...menuRows(adminMenu())]);
}
