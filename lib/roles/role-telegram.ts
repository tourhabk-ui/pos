/**
 * Меню роли на живом входе Telegram. Прокатчик пилота и просьба туриста
 * сюда не попадают: первое уже отвечает своей строкой, второе — Кузьмичу.
 */

import { loadInbox } from '@/lib/crm/inbox';
import { findPartnerByChat, processPartnerMessage } from '@/lib/kuzmich/operator-chat';
import { boundChatLane } from '@/lib/kuzmich/bound-chat-route';
import { isOperatorDatesPhrase } from '@/lib/operators/chat-dates/flow';
import { chatDatesIntent } from '@/lib/operators/chat-dates/parse';
import { telegramDatesText } from '@/lib/operators/chat-dates/texts';
import { appendMenu, type MenuButton } from '@/lib/roles/chat-menu';
import {
  menuRoleOf, parseRoleMenuPress, partnerMenu, partnerMenuHelp, roleMenuAsk,
  type RoleAsk,
} from '@/lib/roles/role-menu';
import { roleMenuScreen } from '@/lib/roles/role-screen';
import {
  loadOperatorTours, operatorHelpText, operatorInboxView, operatorSeatsText, operatorToursReply, SUPPORT_BUTTON,
} from '@/lib/telegram/operator-desk';
import { setOperatorChatCommands } from '@/lib/telegram/role-commands';

export type RoleSend = (text: string, buttons: MenuButton[][]) => Promise<void>;

const NOT_THIS = 'Эта кнопка — меню кабинета. В этом чате её не выполняю.';
const UNREAD = 'Не удалось проверить, чей это чат. Кнопку не выполнил.';

export async function tryRoleMenuTelegramMessage(opts: {
  chatId: number;
  text: string;
  fromName: string | null;
  send: RoleSend;
  /** Постоянная клавиатура телефона. Ставится на /start, не на каждое сообщение. */
  sendPersistent?: (text: string) => Promise<void>;
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
  const head = opts.text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const fromSlash: RoleAsk | null = head === '/start' || head === '/help'
    ? 'help'
    : head === '/requests'
      ? 'inbox'
      : head === '/tours'
        ? 'tours'
        : head === '/seats'
          ? 'seats'
          : null;
  if (head.startsWith('/') && fromSlash === null) return false;
  const asked = fromSlash ?? roleMenuAsk(opts.text);
  const open = async (action: 'inbox' | 'help' | 'summary') => {
    const screen = await roleMenuScreen({
      role, action, channel: 'telegram', partner, nowMs: Date.now(),
    });
    await send(screen.text, []);
  };
  if (asked === 'help') {
    if (role === 'operator') {
      if (head === '/start' && opts.sendPersistent) {
        await opts.sendPersistent(operatorHelpText());
        void setOperatorChatCommands(opts.chatId);
        await send('Дальше — кнопки внизу. Заявка в поддержку создаётся только кнопкой «Написать в поддержку».', [[SUPPORT_BUTTON]]);
      } else {
        await send(operatorHelpText(), [[SUPPORT_BUTTON]]);
      }
      return true;
    }
    await send(partnerMenuHelp(role, menu), []);
    return true;
  }
  if (asked === 'inbox') {
    if (role === 'operator') {
      const inbox = await loadInbox(partner.partnerId, 'operator', partner.userId ?? null, { nowMs: Date.now() });
      const view = operatorInboxView(inbox);
      await send(view.text, view.buttons);
      return true;
    }
    await open('inbox');
    return true;
  }
  if (asked === 'tours' || asked === 'seats') {
    if (partner.category !== 'operator') {
      await send('Эта кнопка — кабинет туроператора. В этом чате её не выполняю.', []);
      return true;
    }
    if (asked === 'tours') {
      await send(operatorToursReply(await loadOperatorTours(partner.partnerId)), []);
    } else {
      await send(operatorSeatsText(), []);
    }
    return true;
  }
  // Даты словами в Telegram не пишутся: кнопки подтверждения нет. Фраза
  // туроператора получает тот же ответ, что вторая дверь, и до помощника
  // не доходит — иначе он может сказать «открыл», не открыв.
  if (partner.category === 'operator'
    && chatDatesIntent(opts.text) === 'dates'
    && await isOperatorDatesPhrase(opts.text, partner.partnerId)) {
    await send(telegramDatesText(), []);
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
