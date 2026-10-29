/**
 * Меню роли на живом входе Telegram. Прокатчик пилота и просьба туриста
 * сюда не попадают: первое уже отвечает своей строкой, второе — Кузьмичу.
 */

import { loadInbox } from '@/lib/crm/inbox';
import { findPartnerByChat, processPartnerMessage } from '@/lib/kuzmich/operator-chat';
import { boundChatContext, boundChatLaneFor } from '@/lib/kuzmich/bound-chat-route';
import { isRentalPilotSlug } from '@/lib/rental/operator-pilot';
import { withSosBlock } from '@/lib/safety/sos-detector';
import { isOperatorDatesPhrase } from '@/lib/operators/chat-dates/flow';
import { chatDatesIntent } from '@/lib/operators/chat-dates/parse';
import { datesSellerOf, telegramDatesText } from '@/lib/operators/chat-dates/texts';
import { appendMenu, type MenuButton } from '@/lib/roles/chat-menu';
import {
  menuRoleOf, parseRoleMenuPress, partnerMenu, partnerMenuHelp, roleMenuAsk,
  type RoleAsk,
} from '@/lib/roles/role-menu';
import { roleMenuScreen } from '@/lib/roles/role-screen';
import {
  loadOperatorTours, operatorHelpText, operatorInboxView, operatorSeatsText, operatorToursReply, SUPPORT_BUTTON,
} from '@/lib/telegram/operator-desk';
import { operatorInboxOrHelpPress } from '@/lib/telegram/operator-desk-press';
import { roleChatCommands, setOperatorChatCommands, setRoleChatCommands } from '@/lib/telegram/role-commands';
import { sellsOwnTours } from '@/lib/partners/tour-seller';
import { chatActionsEnabledFor } from '@/lib/bookings/chat-owner-press';

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
  /**
   * Вид чата Telegram (`message.chat.type`). Кнопки действий брони и ожидание
   * причины отклонения — только в личном (`private`); нет поля — не личный.
   */
  chatType?: string;
}): Promise<boolean> {
  const lookup = await findPartnerByChat('telegram', opts.chatId);
  if (lookup.outcome !== 'found') return false;
  const privateChat = opts.chatType === 'private';
  // Причина отклонения брони (гид, 29.10): после «Отклонить» следующее
  // сообщение личного чата — причина для туриста. Раньше полосы: «турист
  // заболел» иначе ушло бы Кузьмичу туриста. Беда в тексте — блок 112.
  // Модуль действия тянет правила смены статуса брони и заявки — грузится,
  // только когда кнопки этой карточке включены (остальным причину не ждут).
  if (privateChat && chatActionsEnabledFor(lookup.partner)) {
    const { captureOwnerReason } = await import('@/lib/bookings/chat-owner-action');
    const reason = await captureOwnerReason({ channel: 'telegram', chatId: opts.chatId, partner: lookup.partner, text: opts.text });
    if (reason) {
      await opts.send(withSosBlock(reason.text, opts.text).text, reason.buttons);
      return true;
    }
  }
  const menu = partnerMenu(lookup.partner);
  const role = menuRoleOf(lookup.partner);
  if (!menu || !role) {
    // Агент и прокат снаряжения: меню роли нет, а CRM есть. В MAX и на втором
    // входе их текст получает помощник с CRM, а здесь уходил Кузьмичу туриста
    // (проверка каналов 25.10). Пилот проката отвечает своей строкой раньше.
    const p = lookup.partner;
    if (isRentalPilotSlug(p.slug) || p.crmCategory === null || opts.text.trim().startsWith('/')) return false;
    if (boundChatLaneFor('telegram', opts.chatId, opts.text, boundChatContext(p)) === 'tourist') return false;
    await processPartnerMessage({
      chatId: opts.chatId,
      text: opts.text,
      fromName: opts.fromName,
      partner: p,
      reply: async (_id, text) => { await opts.send(withSosBlock(text, opts.text).text, []); },
    });
    return true;
  }
  if (boundChatLaneFor('telegram', opts.chatId, opts.text, boundChatContext(lookup.partner)) === 'tourist') return false;

  // Беда в тексте — блок 112 над любым ответом меню роли (даты, входящие,
  // помощник): команда кабинета и дело CRM в той же фразе остаются здесь.
  const send: RoleSend = async (text, buttons) => {
    await opts.send(withSosBlock(text, opts.text).text, appendMenu(buttons, menu));
  };
  const partner = lookup.partner;
  const head = opts.text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  // «/bookings» — команда строки гида («Брони»). У остальных ролей её нет,
  // и она уходит дальше, как любая чужая команда.
  const fromSlash: RoleAsk | 'bookings' | null = head === '/start' || head === '/help'
    ? 'help'
    : head === '/requests'
      ? 'inbox'
      : head === '/tours'
        ? 'tours'
        : head === '/seats'
          ? 'seats'
          : head === '/bookings' && role === 'guide'
            ? 'bookings'
            : null;
  if (head.startsWith('/') && fromSlash === null) return false;
  const asked = fromSlash ?? roleMenuAsk(opts.text);
  const open = async (action: 'inbox' | 'help' | 'summary' | 'bookings' | 'tours') => {
    const screen = await roleMenuScreen({
      role, action, channel: 'telegram', partner, nowMs: Date.now(),
    });
    // Кнопки действий брони — только в личном чате: в группе их нажал бы любой.
    await send(screen.text, privateChat ? (screen.buttons ?? []) : []);
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
    // Гиду команды чата — из его строки меню (Входящие, Брони, Мои туры,
    // Помощь), на «Старт», как оператору.
    if (role === 'guide' && head === '/start') void setRoleChatCommands(opts.chatId, roleChatCommands(menu));
    await send(partnerMenuHelp(role, menu), []);
    return true;
  }
  if (asked === 'bookings') {
    // Экран без ПД: канал telegram (lib/guides/chat-screens).
    await open('bookings');
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
    if (!sellsOwnTours(partner)) {
      await send('Эта кнопка — кабинет туроператора. В этом чате её не выполняю.', []);
      return true;
    }
    // Гид со своими турами — его раздел «Свои туры», не кабинет оператора.
    if (partner.category === 'guide') {
      if (asked === 'tours') await open('tours');
      else await send(operatorSeatsText('guide'), []);
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
  // продавца своих туров (туроператор, гид с турами — 29.10) получает тот же
  // ответ, что вторая дверь, со ссылкой в его кабинет, и до помощника не
  // доходит — иначе он может сказать «открыл», не открыв.
  if (sellsOwnTours(partner)
    && chatDatesIntent(opts.text) === 'dates'
    && await isOperatorDatesPhrase(opts.text, partner.partnerId)) {
    await send(telegramDatesText(datesSellerOf(partner)), []);
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
  /**
   * Нажатие из личного чата канонического вебхука: только там стоят кнопки
   * действий брони (`bk:`) и только там есть их обработчик. Нет поля — без них.
   */
  privateChat?: boolean;
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
  if (press.role === 'operator' && (press.action === 'inbox' || press.action === 'help')) {
    const view = await operatorInboxOrHelpPress({
      action: press.action,
      partnerId: lookup.partner.partnerId,
      userId: lookup.partner.userId,
      menu,
      nowMs: Date.now(),
    });
    await opts.send(view.text, view.buttons);
    return true;
  }
  const screen = await roleMenuScreen({
    role: press.role,
    action: press.action,
    channel: 'telegram',
    partner: lookup.partner,
    nowMs: Date.now(),
  });
  const actions = opts.privateChat === true ? (screen.buttons ?? []) : [];
  await opts.send(screen.text, menu.length ? appendMenu(actions, menu) : []);
  return true;
}
