/**
 * Сообщение администратора в Telegram.
 *
 * Чтения — те же, что в MAX (lib/roles/role-screen, канал telegram): контакты
 * туристов в этот канал не отдаются, правило владельца 23.08 «ПД только в
 * MAX». sendPdAlert отсюда не зовётся.
 *
 * Туристическая просьба в привязанном чате идёт Кузьмичу туриста раньше
 * разбора команды: в команде администратора «брон» — подстрока, и «хочу
 * забронировать тур» иначе открыло бы список броней. Непонятое — справка
 * кабинета, не модель.
 *
 * Консоль TELEGRAM_CHAT_ID (/stats, /post, статус заявки) этот модуль не
 * выдаёт: её оставляет вызывающий тем, кого привязка не забрала.
 */

import { escapeHtml } from '@/lib/text/escape-html';
import { boundChatLaneFor } from '@/lib/kuzmich/bound-chat-route';
import { withSosBlock } from '@/lib/safety/sos-detector';
import { adminMenu, adminMenuHelp } from '@/lib/roles/role-menu';
import { roleMenuScreen } from '@/lib/roles/role-screen';
import type { MenuButton } from '@/lib/roles/chat-menu';
import { adminCommandOf } from '@/lib/max/admin-read';
import {
  ADMIN_TG_TEXT,
  adminTelegramTokenFromStart,
  consumeAdminTelegramLink,
  findTelegramAdmin,
  type ConsumeAdminTelegramLink,
} from '@/lib/telegram/admin-link';

export const TELEGRAM_ADMIN_UNCHECKED =
  'Роль администратора не проверена: база не ответила. Кнопку не выполняю.';
export const TELEGRAM_ADMIN_DENY =
  'Эта кнопка — кабинет администратора. В этом чате её не выполняю.';
// Голос и фото здесь не разбираются, а в них может быть беда: строка 112 —
// в самом отказе.
const TEXT_ONLY =
  'Как администратор принимаю в Telegram только текст: фото, голос и номера здесь не обрабатываю. В беде — звоните 112.';

type Reply = (text: string, buttons?: MenuButton[][]) => Promise<void>;

export function telegramAdminHello(name: string | null): string {
  const who = `Вы подключены как администратор Ведара${name ? `, ${escapeHtml(name)}` : ''}. `
    + 'Права проверяются на каждом сообщении.';
  return `${who}\n\n${adminMenuHelp()}`;
}

/**
 * Ссылка старта `adt_`. false — ссылка не наша. telegramUserId — from.id,
 * без отката на id чата.
 */
export async function handleTelegramAdminStart(
  arg: string,
  telegramUserId: number | null,
  reply: Reply,
): Promise<boolean> {
  const token = adminTelegramTokenFromStart(arg);
  if (token === null) return false;
  if (token === 'malformed') { await reply(ADMIN_TG_TEXT.malformed); return true; }
  if (telegramUserId === null || !Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) {
    await reply(ADMIN_TG_TEXT.noUser);
    return true;
  }
  let res: ConsumeAdminTelegramLink;
  try {
    res = await consumeAdminTelegramLink(token, telegramUserId);
  } catch (err) {
    console.error('[telegram/admin] ссылка подключения не погашена, SQLSTATE', (err as { code?: string })?.code ?? 'нет SQLSTATE');
    await reply(ADMIN_TG_TEXT.failed);
    return true;
  }
  if (!res.ok) {
    const text = {
      invalid: ADMIN_TG_TEXT.invalid,
      used: ADMIN_TG_TEXT.used,
      already_yours: ADMIN_TG_TEXT.alreadyYours,
      expired: ADMIN_TG_TEXT.expired,
      not_admin: ADMIN_TG_TEXT.notAdmin,
    }[res.reason];
    await reply(text);
    return true;
  }
  const body = res.movedFromUserId ? `${ADMIN_TG_TEXT.bound}\n\n${ADMIN_TG_TEXT.moved}` : ADMIN_TG_TEXT.bound;
  await reply(body, [adminMenu()]);
  return true;
}

async function answerTelegramAdmin(opts: {
  name: string | null;
  text: string;
  reply: Reply;
  nowMs?: number;
}): Promise<void> {
  if (/^\/start\b/i.test(opts.text.trim())) {
    await opts.reply(telegramAdminHello(opts.name), [adminMenu()]);
    return;
  }
  const cmd = adminCommandOf(opts.text);
  const action = cmd === 'help' || cmd === 'dates' || cmd === 'bookings' || cmd === 'leads'
    || cmd === 'summary' || cmd === 'health'
    ? cmd
    : null;
  if (!action) {
    await opts.reply(`Не понял команду.\n\n${adminMenuHelp()}`, [adminMenu()]);
    return;
  }
  const screen = await roleMenuScreen({
    role: 'admin',
    action,
    channel: 'telegram',
    partner: null,
    nowMs: opts.nowMs,
  });
  await opts.reply(screen.text, [adminMenu()]);
}

/**
 * Личное сообщение. 'handled' — кабинет ответил. 'tourist' — просьба туриста,
 * её отвечает Кузьмич, не кабинет. 'pass' — это не кабинет администратора
 * (в том числе «не смог проверить»: обычный путь ПД туристов не показывает).
 * Чужой /start (op_, link_, lead) — pass без запроса к привязке.
 */
export async function handleTelegramAdminTurn(opts: {
  text: string | null;
  fromId: number;
  reply: Reply;
  nowMs?: number;
}): Promise<'handled' | 'tourist' | 'pass'> {
  const text = opts.text;
  if (text !== null && /^\/start\s+\S/.test(text.trim())) {
    const arg = text.trim().slice('/start'.length).trim();
    const started = await handleTelegramAdminStart(arg, opts.fromId, opts.reply);
    return started ? 'handled' : 'pass';
  }
  if (!Number.isSafeInteger(opts.fromId) || opts.fromId <= 0) return 'pass';
  const admin = await findTelegramAdmin(opts.fromId);
  if (admin.outcome !== 'admin') return 'pass';
  if (text === null || text.trim().length === 0) {
    await opts.reply(TEXT_ONLY);
    return 'handled';
  }
  // Беда — Кузьмичу туриста при любых словах: у администратора нет CRM, и
  // исключение «дело CRM остаётся кабинетом» ему не нужно. Обёртка ниже —
  // страховка на случай, если беду узнает не классификатор, а блок 112.
  if (!/^\/start\b/i.test(text.trim())
    && boundChatLaneFor('telegram', opts.fromId, text, { admin: true, nowMs: opts.nowMs }) === 'tourist') {
    return 'tourist';
  }
  await answerTelegramAdmin({
    name: admin.name,
    text,
    reply: (body, buttons) => opts.reply(withSosBlock(body, text).text, buttons),
    nowMs: opts.nowMs,
  });
  return 'handled';
}

/**
 * Кнопка `rm:ad:`. legacy — чат TELEGRAM_CHAT_ID / владельца: консоль живёт
 * и когда привязки нет. «Не смог проверить» и нет legacy — кнопку не
 * выполняем и не называем человека не-админом.
 */
export async function telegramAdminCallbackGate(
  fromId: number,
  legacyAdmin: boolean,
): Promise<'allow' | 'deny' | 'unchecked'> {
  const found = await findTelegramAdmin(fromId);
  if (found.outcome === 'admin' || legacyAdmin) return 'allow';
  if (found.outcome === 'unavailable') return 'unchecked';
  return 'deny';
}
