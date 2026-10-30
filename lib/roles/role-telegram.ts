/**
 * Меню роли на живом входе Telegram. Прокатчик пилота и просьба туриста
 * сюда не попадают: первое уже отвечает своей строкой, второе — Кузьмичу.
 *
 * Вкладки кабинета в чате — «Входящие», «Задачи», «Клиенты», «Ещё» — экраны
 * lib/chat-cabinet: вызывающий отдаёт их своей `sendCabinet` (у экрана
 * кнопки-ссылки и строка кабинета, это не строка меню роли). В Telegram на
 * них нет имён, телефонов и заголовков задач (замок — в сервисе кабинета).
 */

import type { CabinetScreen } from '@/lib/chat-cabinet/screens';
import { cabinetSectionFor, type CabinetSection } from '@/lib/chat-cabinet/service';
import { memberCabinetText } from '@/lib/chat-cabinet/member-entry';
import { findPartnerByChat, processPartnerMessage } from '@/lib/kuzmich/operator-chat';
import { boundChatContext, boundChatLaneFor } from '@/lib/kuzmich/bound-chat-route';
import { isRentalPilotSlug } from '@/lib/rental/operator-pilot';
import { withSosBlock } from '@/lib/safety/sos-detector';
import { isOperatorDatesPhrase } from '@/lib/operators/chat-dates/flow';
import { chatDatesIntent } from '@/lib/operators/chat-dates/parse';
import { datesSellerOf, telegramDatesText } from '@/lib/operators/chat-dates/texts';
import { appendMenu, type MenuButton } from '@/lib/roles/chat-menu';
import {
  menuRoleOf, parseRoleMenuPress, partnerMenu, partnerMenuExtras, partnerMenuHelp, roleMenuAsk,
  type RoleAsk,
} from '@/lib/roles/role-menu';
import { isCabinetSection, roleMenuScreen } from '@/lib/roles/role-screen';
import {
  loadOperatorTours, operatorHelpText, operatorSeatsText, operatorToursReply, SUPPORT_BUTTON,
} from '@/lib/telegram/operator-desk';
import { operatorHelpPress } from '@/lib/telegram/operator-desk-press';
import { roleChatCommands, setOperatorChatCommands, setRoleChatCommands } from '@/lib/telegram/role-commands';
import { sellsOwnTours } from '@/lib/partners/tour-seller';
import { chatActionsEnabledFor } from '@/lib/bookings/chat-owner-press';

export type RoleSend = (text: string, buttons: MenuButton[][]) => Promise<void>;
/** Экран кабинета в чате: новым сообщением, со своими кнопками. */
export type CabinetSend = (screen: CabinetScreen) => Promise<void>;

const NOT_THIS = 'Эта кнопка — меню кабинета. В этом чате её не выполняю.';
const UNREAD = 'Не удалось проверить, чей это чат. Кнопку не выполнил.';
export const CABINET_IN_DIALOG = 'Кабинет в чате открывается в личном диалоге с ботом: в группе кнопки нажал бы любой участник.';

/**
 * Чат менеджера команды оператора: слово меню или команда открывают его
 * кабинет в чате (lib/chat-cabinet/member-entry) — без имён и телефонов, как
 * всё в Telegram. Прочий текст идёт дальше своим путём, как раньше. Только
 * личный чат: вызывающий это уже проверил.
 */
function tryMemberCabinetTelegram(opts: { chatId: number; text: string; send: RoleSend; sendCabinet: CabinetSend }): Promise<boolean> {
  return memberCabinetText({ channel: 'telegram', chatId: opts.chatId, text: opts.text }, {
    show: async (screen, userText) => {
      const sos = withSosBlock('', userText);
      if (sos.emergency) await opts.send(sos.text.trim(), []);
      await opts.sendCabinet(screen);
    },
    say: (body) => opts.send(body, []),
  });
}

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
  /** Экран кабинета в чате («Входящие», «Задачи», «Клиенты»). */
  sendCabinet: CabinetSend;
}): Promise<boolean> {
  const lookup = await findPartnerByChat('telegram', opts.chatId);
  const privateChat = opts.chatType === 'private';
  if (lookup.outcome === 'none' && privateChat) return tryMemberCabinetTelegram(opts);
  if (lookup.outcome !== 'found') return false;
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
  // Роль гида, этап 2 (30.10): ответ на отзыв после «Ответить» и «о себе: …»
  // (lib/guides/chat-role) — черновик, пишет только кнопка; раньше правки тура.
  if (privateChat) {
    const { captureGuideRoleText } = await import('@/lib/guides/chat-role/flow');
    const role = await captureGuideRoleText({ channel: 'telegram', chatId: opts.chatId, partner: lookup.partner, text: opts.text });
    if (role) {
      const sos = withSosBlock('', opts.text);
      if (sos.emergency) await opts.send(sos.text.trim(), []);
      await opts.sendCabinet(role);
      return true;
    }
  }
  // Правка своего тура гидом (30.10): «Горелый: описание: …» — черновик и
  // «было → станет» с кнопками «Сохранить» / «Отмена» (lib/guides/tour-edit).
  // В тур пишет только кнопка. Раньше полосы туриста: строгая форма фразы —
  // дело гида. Текст тура — не ПД, поэтому и в Telegram; только личный чат.
  if (privateChat) {
    const { captureGuideTourEdit } = await import('@/lib/guides/tour-edit/flow');
    const edit = await captureGuideTourEdit({ channel: 'telegram', chatId: opts.chatId, partner: lookup.partner, text: opts.text });
    if (edit) {
      const sos = withSosBlock('', opts.text);
      if (sos.emergency) await opts.send(sos.text.trim(), []);
      await opts.sendCabinet(edit);
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
      channel: 'telegram',
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
  const SLASH: Readonly<Partial<Record<string, RoleAsk>>> = {
    '/start': 'help', '/help': 'help', '/requests': 'inbox', '/tasks': 'tasks', '/clients': 'clients',
    '/tours': 'tours', '/seats': 'seats',
  };
  const fromSlash: RoleAsk | 'bookings' | null = SLASH[head]
    ?? (head === '/bookings' && role === 'guide' ? 'bookings' : null);
  if (head.startsWith('/') && fromSlash === null) return false;
  const asked = fromSlash ?? roleMenuAsk(opts.text);
  // Кабинет в чате — только в личном: в группе кнопки карточек нажал бы любой.
  const openCabinet = async (section: CabinetSection) => {
    if (!privateChat) {
      await send(CABINET_IN_DIALOG, []);
      return;
    }
    const screen = await cabinetSectionFor(partner, 'telegram', section, Date.now());
    // Беда в тексте — блок 112 отдельным сообщением перед экраном: кнопки
    // кабинета правят сообщение, под которым стоят, и блок над экраном стёрла
    // бы первая же из них.
    const sos = withSosBlock('', opts.text);
    if (sos.emergency) await opts.send(sos.text.trim(), []);
    await opts.sendCabinet(screen);
  };
  const open = async (action: 'help' | 'summary' | 'bookings' | 'tours') => {
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
    // Гиду команды чата — из его вкладок и «Ещё» (Входящие, Задачи,
    // Клиенты, Брони, Мои туры, Помощь), на «Старт», как оператору.
    if (role === 'guide' && head === '/start') {
      void setRoleChatCommands(opts.chatId, roleChatCommands([...menu, ...partnerMenuExtras(partner)]));
    }
    await send(partnerMenuHelp(role, partner), []);
    return true;
  }
  if (asked === 'bookings') {
    // Экран без ПД: канал telegram (lib/guides/chat-screens).
    await open('bookings');
    return true;
  }
  if (asked === 'inbox' || asked === 'tasks' || asked === 'clients' || asked === 'busy') {
    await openCabinet(asked);
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
    channel: 'telegram',
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
   * действий брони (`bk:`) и только там есть их обработчик. Нет поля — без них
   * и без вкладок кабинета.
   */
  privateChat?: boolean;
  /** Экран кабинета в чате для вкладок строки меню. */
  sendCabinet: CabinetSend;
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
  if (isCabinetSection(press.action)) {
    if (opts.privateChat !== true) {
      await opts.send(CABINET_IN_DIALOG, []);
      return true;
    }
    await opts.sendCabinet(await cabinetSectionFor(lookup.partner, 'telegram', press.action, Date.now()));
    return true;
  }
  if (press.role === 'operator' && press.action === 'help') {
    const view = operatorHelpPress(menu);
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
