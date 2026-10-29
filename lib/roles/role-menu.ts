/**
 * Меню роли в привязанном чате: одна строка под ответом кабинета.
 * Кнопка есть только там, где действие уже написано.
 *
 * Прокатчик пилота сюда не входит: у него своя строка `rk:`
 * (lib/rental/cabinet-bar). Агенту и снаряжению кнопку не рисуем:
 * у агента входящих нет, отдельного чтения для снаряжения в чате нет.
 *
 * Администратор — шесть чтений из lib/max/admin-read. Партнёр —
 * «Входящие» кабинета (loadInbox) и, у пилота запросов мест, «Сводка».
 * Гид, который продаёт свои туры (`sellsOwnTours`, 29.10), — ещё «Брони» и
 * «Мои туры»: те же чтения, что раздел «Свои туры» на сайте
 * (lib/guides/chat-screens). Гид команды оператора без своих туров —
 * прежняя строка: броней и туров ему показывать нечего.
 */

import { getPublicBaseUrl } from '@/lib/config';
import { GUIDE_OWN_PATH } from '@/lib/partners/cabinet-links';
import { sellsOwnTours } from '@/lib/partners/tour-seller';
import { isRentalPilotSlug } from '@/lib/rental/operator-pilot';
import { summaryEnabledFor } from '@/lib/seat-requests/summary';
import type { MenuButton } from '@/lib/roles/chat-menu';

export type MenuRole = 'admin' | 'operator' | 'transfer' | 'stay' | 'guide';

export type MenuAction = 'inbox' | 'summary' | 'dates' | 'bookings' | 'leads' | 'tours' | 'health' | 'help';

const ROLE_CODE: Record<MenuRole, string> = {
  admin: 'ad',
  operator: 'op',
  transfer: 'tf',
  stay: 'st',
  guide: 'gd',
};

const CODE_ROLE = new Map(Object.entries(ROLE_CODE).map(([role, code]) => [code, role as MenuRole]));

const ACTION_CODE: Record<MenuAction, string> = {
  inbox: 'in',
  summary: 'sm',
  dates: 'dt',
  bookings: 'bk',
  leads: 'ld',
  tours: 'tr',
  health: 'hl',
  help: 'hp',
};

const CODE_ACTION = new Map(Object.entries(ACTION_CODE).map(([action, code]) => [code, action as MenuAction]));

function button(role: MenuRole, action: MenuAction, text: string): MenuButton {
  return { text, payload: `rm:${ROLE_CODE[role]}:${ACTION_CODE[action]}` };
}

export function adminMenu(): MenuButton[] {
  return [
    button('admin', 'dates', 'Даты'),
    button('admin', 'bookings', 'Брони'),
    button('admin', 'leads', 'Заявки'),
    button('admin', 'summary', 'Сводка'),
    button('admin', 'health', 'Здоровье'),
    button('admin', 'help', 'Помощь'),
  ];
}

export interface MenuPartner {
  partnerId: string;
  category: string;
  slug?: string | null;
  /** `partners.user_id`. Нет аккаунта — непрочитанное чата кабинета не считается. */
  userId?: string | null;
  /**
   * Есть ли у карточки свои неудалённые туры — `findPartnerByChat` и
   * `bindPartnerChannel` читают его тем же запросом, что карточку. Решает
   * `sellsOwnTours`; поля нет — не продаёт.
   */
  sellsTours?: boolean;
}

/**
 * Окно «ближайших» броней в чате гида, дней. Одно число на экран «Брони»
 * (lib/guides/chat-screens) и справку, которая его называет. На сайте — все
 * предстоящие.
 */
export const CHAT_BOOKINGS_WINDOW_DAYS = 14;

/** Гид, который продаёт свои туры: у него в строке «Брони» и «Мои туры». */
export function guideSellsOwnTours(partner: MenuPartner): boolean {
  return partner.category === 'guide' && sellsOwnTours(partner);
}

/** null — этой записи меню роли нет (пилот проката, агент, снаряжение, чужая категория). Админ сюда не входит: его меню не из карточки партнёра. */
export function menuRoleOf(partner: MenuPartner): Exclude<MenuRole, 'admin'> | null {
  if (isRentalPilotSlug(partner.slug)) return null;
  if (
    partner.category === 'operator'
    || partner.category === 'transfer'
    || partner.category === 'stay'
    || partner.category === 'guide'
  ) return partner.category;
  return null;
}

/** Строка партнёра. Пустая не возвращается: нет действия — нет меню. */
export function partnerMenu(partner: MenuPartner): MenuButton[] | null {
  const role = menuRoleOf(partner);
  if (!role) return null;
  const row: MenuButton[] = [button(role, 'inbox', 'Входящие')];
  if (role === 'operator' && summaryEnabledFor(partner.partnerId)) {
    row.push(button(role, 'summary', 'Сводка'));
  }
  if (guideSellsOwnTours(partner)) {
    row.push(button(role, 'bookings', 'Брони'), button(role, 'tours', 'Мои туры'));
  }
  row.push(button(role, 'help', 'Помощь'));
  return row;
}

export function parseRoleMenuPress(payload: string): { role: MenuRole; action: MenuAction } | null {
  const match = /^rm:([a-z]{2}):([a-z]{2})$/.exec(payload);
  if (!match) return null;
  const role = CODE_ROLE.get(match[1] ?? '');
  const action = CODE_ACTION.get(match[2] ?? '');
  if (!role || !action) return null;
  if (role === 'admin') {
    // У администратора нет «Входящих» и «Моих туров» — только его шесть чтений.
    if (action === 'inbox' || action === 'tours') return null;
    return { role, action };
  }
  if (action === 'inbox' || action === 'summary' || action === 'help') return { role, action };
  // «Брони» и «Мои туры» — только у гида. Продаёт ли он свои туры, решает
  // экран по карточке чата, а не payload.
  if (role === 'guide' && (action === 'bookings' || action === 'tours')) return { role, action };
  return null;
}

function norm(text: string): string {
  return text.trim().toLowerCase().replace(/ё/g, 'е').replace(/[.!?…]+$/g, '').replace(/\s+/g, ' ');
}

export type RoleAsk = 'inbox' | 'help' | 'tours' | 'seats';

/** Точная фраза кнопки. «покажи входящие» и голое «заявки» сюда не входят. */
export function roleMenuAsk(text: string): RoleAsk | null {
  switch (norm(text)) {
    case 'входящие':
    case 'мои входящие':
    case 'новые заявки':
    case 'мои заявки':
      return 'inbox';
    case 'мои туры и цены':
      return 'tours';
    case 'обновить места':
      return 'seats';
    case 'помощь':
    case 'справка':
      return 'help';
    default:
      return null;
  }
}

const ROLE_TITLE: Record<Exclude<MenuRole, 'admin'>, string> = {
  operator: 'Кабинет оператора',
  transfer: 'Кабинет перевозчика',
  stay: 'Кабинет жилья',
  guide: 'Кабинет гида',
};

const INBOX_LINE: Record<Exclude<MenuRole, 'admin'>, string> = {
  operator: 'Входящие — брони, запросы мест, заявки вам и отзывы, которые ждут ответа. Имени и телефона туриста в этом списке нет.',
  transfer: 'Входящие — места в машине, которые ждут ответа. Заявку на машину целиком ведёт менеджер Ведара: здесь на неё кнопки нет.',
  stay: 'Входящие — брони жилья и отзывы гостей без ответа. Имени и телефона гостя в этом списке нет.',
  // Тот же список, что «Входящие» кабинета гида (INBOX_BY_CATEGORY.guide).
  guide: 'Входящие — брони, запросы мест и заявки на туры, которые вы продаёте сами, приглашения в команду и отзывы без ответа. Имени и телефона туриста в этом списке нет.',
};

/** Справка называет только кнопки этой строки. Цен и оплаты нет. */
export function partnerMenuHelp(role: Exclude<MenuRole, 'admin'>, menu: MenuButton[]): string {
  const labels = menu.map((b) => b.text).join(', ');
  const lines = [
    `${ROLE_TITLE[role]}. Под ответом кнопки: ${labels}.`,
    INBOX_LINE[role],
  ];
  if (menu.some((b) => b.payload.endsWith(':sm'))) {
    lines.push('Сводка — числа по запросам мест: сколько ждут, без имени и телефона.');
  }
  const bookings = menu.some((b) => b.payload.endsWith(':bk'));
  const tours = menu.some((b) => b.payload.endsWith(':tr'));
  if (bookings) {
    lines.push(`Брони — ждут вашего ответа и действующие на ближайшие ${CHAT_BOOKINGS_WINDOW_DAYS} дней. Имя и телефон туриста — только в MAX.`);
  }
  if (tours) {
    lines.push('Мои туры — ваши туры: на сайте или черновик и сколько открытых дат.');
  }
  if (bookings || tours) {
    lines.push(`Подтвердить или отклонить бронь и открыть даты — в кабинете, раздел «Свои туры»: ${getPublicBaseUrl()}${GUIDE_OWN_PATH}`);
  }
  lines.push('Помощь — этот текст.');
  lines.push('Оплата через платформу не принимается.');
  return lines.join('\n');
}

export function adminMenuHelp(): string {
  return [
    'Кабинет администратора. Под ответом те же кнопки:',
    'Даты — открытые даты туров витрины на 30 дней.',
    'Брони — ждут подтверждения оператора. Контакты туристов — только в MAX.',
    'Заявки — без ответа человека. Контакты — только в MAX.',
    'Сводка — посетители и ответы Кузьмича за сегодня и вчера.',
    'Здоровье — последний прогон сторожа платформы.',
    'Помощь — этот текст.',
    'Кнопок, которые сами подтверждают бронь или открывают даты, здесь нет.',
  ].join('\n');
}
