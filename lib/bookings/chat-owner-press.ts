/**
 * Кнопки брони и заявки своего тура в чате кабинета (MAX, Telegram) — форма
 * payload, разбор и строки кнопок. Без базы и сети: модуль читают и экраны
 * чата (lib/guides/chat-screens, lib/roles/role-screen), и классификатор
 * нажатий MAX (lib/max/verified-press), и личные уведомления о новой брони и
 * заявке. Само действие — lib/bookings/chat-owner-action.
 *
 * Два шага, как на сайте («Свои туры»: кнопка, затем «Да»):
 *   `bk:<c|x|d|n>:<id брони>`  — вопрос: подтвердить, отклонить (с причиной),
 *                                 тур прошёл, турист не пришёл;
 *   `ld:<k|w|l>:<uuid заявки>` — вопрос: связался, договорились, отказ
 *                                 (шаг 7; «Обсуждаем» — на сайте);
 *   `oc:<y|x>:<uuid строки>`   — «Да» / «Не надо» под вопросом.
 * В payload только номера: id брони, uuid заявки и uuid строки действия.
 * Ни ПД, ни id тура.
 *
 * Кому кнопки включены:
 *  - брони (`bookingChatActionsEnabledFor`) — гиду, который продаёт свои
 *    туры, и туроператору (слово владельца 30.10 «Да, как у гида»: вопрос
 *    3 плана мини-приложения закрыт вариантом A — вопрос, затем «Да»);
 *  - заявки (`leadChatActionsEnabledFor`) — только гиду со своими турами:
 *    туроператор отвечает на заявку кнопками «Принять», «Нет мест»,
 *    «Уточнить», «Свяжусь сам» (lib/requests/chat-answer), и вторую пару
 *    кнопок с другим правилом ему не ставим.
 */
import type { MenuButton } from '@/lib/roles/chat-menu';
import { sellsOwnTours, type TourSellerFacts } from '@/lib/partners/tour-seller';
import { OWNER_LEAD_ACTION_LABEL } from '@/lib/leads/owner-lead-words';

export type BookingChatAction = 'confirm' | 'cancel' | 'complete' | 'no_show';

/** Статус брони, который ставит действие, — правило lib/bookings/owner-status. */
export const BOOKING_ACTION_STATUS: Readonly<Record<BookingChatAction, 'confirmed' | 'cancelled' | 'completed' | 'no_show'>> = {
  confirm: 'confirmed',
  cancel: 'cancelled',
  complete: 'completed',
  no_show: 'no_show',
};

const ACTION_CODE: Readonly<Record<BookingChatAction, string>> = {
  confirm: 'c',
  cancel: 'x',
  complete: 'd',
  no_show: 'n',
};
const CODE_ACTION = new Map(Object.entries(ACTION_CODE).map(([a, c]) => [c, a as BookingChatAction]));

/**
 * Отметка заявки кнопкой — статус, который она ставит (правило
 * lib/leads/owner-lead-status). Действие в строке partner_chat_actions
 * называется самим статусом (CHECK миграции 1346).
 */
export type LeadChatAction = 'contacted' | 'converted' | 'lost';

const LEAD_CODE: Readonly<Record<LeadChatAction, string>> = {
  contacted: 'k',
  converted: 'w',
  lost: 'l',
};
const CODE_LEAD = new Map(Object.entries(LEAD_CODE).map(([a, c]) => [c, a as LeadChatAction]));

/** Порядок кнопок под заявкой. */
export const LEAD_CHAT_ACTIONS: readonly LeadChatAction[] = ['contacted', 'converted', 'lost'];

export function isLeadChatAction(v: string): v is LeadChatAction {
  return (LEAD_CHAT_ACTIONS as readonly string[]).includes(v);
}

/** Префиксы кнопок-действий: по ним вебхук MAX пускает нажатие только заверенным. */
export const OWNER_PRESS_PREFIXES = ['bk:', 'ld:', 'oc:'] as const;

export function isOwnerPressPayload(payload: string): boolean {
  return OWNER_PRESS_PREFIXES.some((p) => payload.startsWith(p));
}

const BOOKING_ID = /^[0-9]{1,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function bookingPressPayload(action: BookingChatAction, bookingId: string): string {
  return `bk:${ACTION_CODE[action]}:${bookingId}`;
}

export function leadPressPayload(action: LeadChatAction, leadId: string): string {
  return `ld:${LEAD_CODE[action]}:${leadId}`;
}

export function answerPressPayload(yes: boolean, actionId: string): string {
  return `oc:${yes ? 'y' : 'x'}:${actionId}`;
}

export type OwnerPress =
  | { kind: 'booking'; action: BookingChatAction; bookingId: string }
  | { kind: 'lead'; action: LeadChatAction; leadId: string }
  | { kind: 'answer'; yes: boolean; actionId: string };

/** null — не наша кнопка или испорченный payload. */
export function parseOwnerPress(payload: string): OwnerPress | null {
  const bk = /^bk:([a-z]):(.+)$/.exec(payload);
  if (bk) {
    const action = CODE_ACTION.get(bk[1] ?? '');
    const id = bk[2] ?? '';
    return action && BOOKING_ID.test(id) ? { kind: 'booking', action, bookingId: id } : null;
  }
  const ld = /^ld:([a-z]):(.+)$/.exec(payload);
  if (ld) {
    const action = CODE_LEAD.get(ld[1] ?? '');
    const id = (ld[2] ?? '').toLowerCase();
    return action && UUID.test(id) ? { kind: 'lead', action, leadId: id } : null;
  }
  const oc = /^oc:([yx]):(.+)$/.exec(payload);
  if (oc) {
    const id = (oc[2] ?? '').toLowerCase();
    return UUID.test(id) ? { kind: 'answer', yes: oc[1] === 'y', actionId: id } : null;
  }
  return null;
}

/** Сколько броней получают кнопки под одним экраном (как у входящих оператора). */
export const OWNER_PRESS_BUTTON_CAP = 2;

/** Под бронью, ждущей ответа: «Подтвердить» и «Отклонить». */
export function bookingAnswerButtons(bookingId: string): MenuButton[] {
  return [
    { text: `Подтвердить №${bookingId}`, payload: bookingPressPayload('confirm', bookingId), intent: 'positive' },
    { text: `Отклонить №${bookingId}`, payload: bookingPressPayload('cancel', bookingId), intent: 'negative' },
  ];
}

/** Под подтверждённой бронью, чья дата прошла: «Тур прошёл» и «Не пришёл». */
export function bookingOutcomeButtons(bookingId: string): MenuButton[] {
  return [
    { text: `Тур прошёл №${bookingId}`, payload: bookingPressPayload('complete', bookingId), intent: 'positive' },
    { text: `Не пришёл №${bookingId}`, payload: bookingPressPayload('no_show', bookingId) },
  ];
}

/** Подпись заявки на кнопке, когда заявок под экраном больше одной. */
const LEAD_REF_MAX = 14;

function clipRef(ref: string): string {
  const t = ref.replace(/\s+/g, ' ').trim();
  return t.length > LEAD_REF_MAX ? `${t.slice(0, LEAD_REF_MAX - 1).trimEnd()}…` : t;
}

/**
 * Под заявкой, ждущей ответа: «Связался», «Договорились», «Отказ» — одной
 * строкой. `ref` — чем отличить заявку, когда их под экраном несколько (её
 * тур словами, как в строке «Входящих»); под личным уведомлением заявка одна,
 * и подписи не нужно. Вопрос «Да / Не надо» называет заявку целиком.
 */
export function leadAnswerButtons(leadId: string, ref: string | null = null): MenuButton[] {
  const tail = ref && ref.trim() ? ` · ${clipRef(ref)}` : '';
  return LEAD_CHAT_ACTIONS.map((action) => ({
    text: `${OWNER_LEAD_ACTION_LABEL[action]}${tail}`,
    payload: leadPressPayload(action, leadId),
    ...(action === 'converted' ? { intent: 'positive' as const } : action === 'lost' ? { intent: 'negative' as const } : {}),
  }));
}

/** Кнопки брони в чате — гиду со своими турами и туроператору (см. шапку). */
export function bookingChatActionsEnabledFor(p: TourSellerFacts): boolean {
  return p.category === 'operator' || (p.category === 'guide' && sellsOwnTours(p));
}

/** Кнопки заявки «Связался / Договорились / Отказ» — только гиду со своими турами. */
export function leadChatActionsEnabledFor(p: TourSellerFacts): boolean {
  return p.category === 'guide' && sellsOwnTours(p);
}

/**
 * Хоть одни кнопки включены: по нему вебхук пускает нажатие к правилу и ждёт
 * причину отклонения брони. Какие именно — решают два правила выше.
 */
export function chatActionsEnabledFor(p: TourSellerFacts): boolean {
  return bookingChatActionsEnabledFor(p) || leadChatActionsEnabledFor(p);
}
