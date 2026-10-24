/**
 * Меню роли на живом входе Telegram. Прокатчик пилота и просьба туриста
 * сюда не попадают: первое уже отвечает своей строкой, второе — Кузьмичу.
 */

import { findPartnerByChat, processPartnerMessage } from '@/lib/kuzmich/operator-chat';
import { boundChatLane } from '@/lib/kuzmich/bound-chat-route';
import { appendMenu, type MenuButton } from '@/lib/roles/chat-menu';
import {
  menuRoleOf, parseRoleMenuPress, partnerMenu, partnerMenuHelp, roleMenuAsk,
} from '@/lib/roles/role-menu';
import { roleMenuScreen } from '@/lib/roles/role-screen';

export type RoleSend = (text: string, buttons: MenuButton[][]) => Promise<void>;

const NOT_THIS = 'Эта кнопка — меню кабинета. В этом чате её не выполняю.';
const UNREAD = 'Не удалось проверить, чей это чат. Кнопку не выполнил.';

export async function tryRoleMenuTelegramMessage(opts: {
  chatId: number;
  text: string;
  fromName: string | null;
  send: RoleSend;
}): Promise<boolean> {
  const lookup = await findPartnerByChat('telegram', opts.chatId);
  if (lookup.outcome !== 'found') return false;
  const menu = partnerMenu(lookup.partner);
  const role = menuRoleOf(lookup.partner);
  if (!menu || !role) return false;
  if (boundChatLane(opts.text) === 'tourist') return false;

  const send: RoleSend = async (text, buttons) => {
    await opts.send(text, appendMenu(buttons, menu));
  };
  const partner = lookup.partner;
  const open = async (action: 'inbox' | 'help' | 'summary') => {
    const screen = await roleMenuScreen({
      role, action, channel: 'telegram', partner, nowMs: Date.now(),
    });
    await send(screen.text, []);
  };
  if (opts.text.trim() === '/start' || roleMenuAsk(opts.text) === 'help') {
    await send(partnerMenuHelp(role, menu), []);
    return true;
  }
  const asked = roleMenuAsk(opts.text);
  if (asked === 'inbox') {
    await open('inbox');
    return true;
  }
  await processPartnerMessage({
    chatId: opts.chatId,
    text: opts.text,
    fromName: opts.fromName,
    partner,
    reply: async (_id, text) => { await send(text, []); },
  });
  return true;
}

/** true — payload нашего меню и ответ уже отправлен. `rm:ad:` сюда не входит. */
export async function tryRoleMenuTelegramPress(opts: {
  chatId: number;
  payload: string;
  send: RoleSend;
}): Promise<boolean> {
  const press = parseRoleMenuPress(opts.payload);
  if (!press || press.role === 'admin') return false;
  const lookup = await findPartnerByChat('telegram', opts.chatId);
  if (lookup.outcome === 'unavailable') {
    await opts.send(UNREAD, []);
    return true;
  }
  if (lookup.outcome !== 'found' || menuRoleOf(lookup.partner) !== press.role) {
    await opts.send(NOT_THIS, []);
    return true;
  }
  const menu = partnerMenu(lookup.partner) ?? [];
  const screen = await roleMenuScreen({
    role: press.role,
    action: press.action,
    channel: 'telegram',
    partner: lookup.partner,
    nowMs: Date.now(),
  });
  await opts.send(screen.text, menu.length ? [menu] : []);
  return true;
}
