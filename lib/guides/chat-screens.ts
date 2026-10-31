/**
 * Экраны гида со своими турами в привязанном чате (MAX, Telegram): «Брони»
 * и «Мои туры». Чтения — те же, что у раздела «Свои туры» на сайте
 * (`loadOwnBookings`, `loadOwnTours`): своего отбора нет, и чат не может
 * показать бронь, которой нет на сайте, или наоборот.
 *
 * Персональные данные туриста (152-ФЗ):
 * - MAX — имя и телефон, как в личном сообщении о новой брони. Экран
 *   возвращается с `pd: true`, и вызывающий шлёт его только через
 *   `sendPdAlert` с `telegramChatId: null`;
 * - Telegram — текст собирается из `OwnBookingNoPd`: поля ПД вырезаны
 *   явным отбором (`withoutPd`), а не типом поверх той же строки, поэтому имя
 *   не попадёт туда и по ошибке в шаблоне. Почта и особые пожелания не
 *   уходят ни в один канал — для ответа хватает телефона, остальное в кабинете.
 *
 * Под экраном «Брони» — кнопки действий (lib/bookings/chat-owner-press): у
 * двух первых ждущих ответа — «Подтвердить» и «Отклонить», у двух первых
 * подтверждённых с прошедшей датой — «Тур прошёл» и «Не пришёл». В payload
 * только номер брони; действие — в два шага (lib/bookings/chat-owner-action).
 *
 * Отказ базы — «не прочиталось», а не «броней нет» (§4.0): имя проверки и
 * SQLSTATE — в лог.
 */
import { kamchatkaDate, ruShort, shiftDate } from '@/lib/analytics/kamchatka-day';
import { OWNER_BOOKING_STATUS_LABEL } from '@/lib/bookings/owner-status-words';
import {
  OWNER_PRESS_BUTTON_CAP, bookingAnswerButtons, bookingOutcomeButtons,
} from '@/lib/bookings/chat-owner-press';
import { loadOwnBookings, loadOwnTours, type OwnBooking, type OwnTour } from '@/lib/guides/own-tours';
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import { getPublicBaseUrl } from '@/lib/config';
import { GUIDE_OWN_PATH } from '@/lib/partners/cabinet-links';
import { CHAT_BOOKINGS_WINDOW_DAYS } from '@/lib/roles/role-menu';
import { escapeHtml } from '@/lib/text/escape-html';
import { STOREFRONT_LABELS, storefrontState } from '@/lib/tours/public-visibility';
import type { MenuButton } from '@/lib/roles/chat-menu';
import { cabinetPayload } from '@/lib/chat-cabinet/payload';

/** Бронь без полей ПД — только из неё строится Telegram-экран. */
export type OwnBookingNoPd = Omit<OwnBooking, 'tourist_name' | 'tourist_phone' | 'tourist_email' | 'special_requests'>;

/** Сколько строк помещается в один ответ; остальное — «ещё N, в кабинете». */
const SHOWN = 12;

const CLOSED = new Set(['new', 'cancelled', 'completed', 'no_show']);

function ownUrl(): string {
  return `${getPublicBaseUrl()}${GUIDE_OWN_PATH}`;
}

/** Явный отбор полей: ПД не переходят даже лишним свойством объекта. */
export function withoutPd(b: OwnBooking): OwnBookingNoPd {
  return {
    id: b.id,
    tour_id: b.tour_id,
    tour_title: b.tour_title,
    booking_date: b.booking_date,
    participants: b.participants,
    booking_status: b.booking_status,
    created_at: b.created_at,
  };
}

/**
 * Что показать в чате: ждущие ответа (любой даты — их держат «Входящие»),
 * действующие брони на ближайшие 14 камчатских дней и подтверждённые, чья
 * дата уже прошла, — их отмечают «тур прошёл» или «не пришёл» (чтение
 * раздела держит прошедшие 30 дней). Отменённые и закрытые не показываются —
 * они в кабинете.
 */
export function bookingsForChat<T extends OwnBookingNoPd>(
  rows: readonly T[],
  nowMs: number,
): { waiting: T[]; upcoming: T[]; past: T[] } {
  const today = kamchatkaDate(new Date(nowMs));
  const last = shiftDate(today, CHAT_BOOKINGS_WINDOW_DAYS);
  const day = (b: T) => b.booking_date.slice(0, 10);
  const byDate = (a: T, b: T) => day(a).localeCompare(day(b));
  const waiting = rows.filter((b) => b.booking_status === 'new').sort(byDate);
  const upcoming = rows
    .filter((b) => !CLOSED.has(b.booking_status) && day(b) >= today && day(b) <= last)
    .sort(byDate);
  const past = rows.filter((b) => b.booking_status === 'confirmed' && day(b) < today).sort(byDate);
  return { waiting, upcoming, past };
}

/** Кнопки под экраном: ответ двум первым ждущим, исход двум первым прошедшим. */
export function bookingButtons<T extends OwnBookingNoPd>(rows: readonly T[], nowMs: number): MenuButton[][] {
  const { waiting, past } = bookingsForChat(rows, nowMs);
  return [
    ...waiting.slice(0, OWNER_PRESS_BUTTON_CAP).map((b) => bookingAnswerButtons(b.id)),
    ...past.slice(0, OWNER_PRESS_BUTTON_CAP).map((b) => bookingOutcomeButtons(b.id)),
  ];
}

function line(b: OwnBookingNoPd, contact: string | null): string {
  const bits = [`№${escapeHtml(b.id)}`, escapeHtml(b.tour_title), ruShort(b.booking_date.slice(0, 10)), `${b.participants} чел`];
  if (b.booking_status !== 'new' && b.booking_status !== 'confirmed') {
    bits.push(escapeHtml(OWNER_BOOKING_STATUS_LABEL[b.booking_status] ?? b.booking_status));
  }
  if (contact) bits.push(contact);
  return `• ${bits.join(' · ')}`;
}

function contactOf(b: OwnBooking): string {
  const name = b.tourist_name?.trim() ? escapeHtml(b.tourist_name.trim()) : 'имя не записано';
  const phone = b.tourist_phone?.trim() ? escapeHtml(b.tourist_phone.trim()) : 'телефон не записан';
  return `${name}, ${phone}`;
}

function bookingsText<T extends OwnBookingNoPd>(
  rows: readonly T[],
  nowMs: number,
  contact: ((b: T) => string) | null,
  tail: string[],
): { text: string; shown: number; buttons: MenuButton[][] } {
  const { waiting, upcoming, past } = bookingsForChat(rows, nowMs);
  const lines = ['<b>Брони</b>'];
  let room = SHOWN;
  const section = (head: string, list: T[]) => {
    lines.push(head);
    const part = list.slice(0, Math.max(room, 0));
    for (const b of part) lines.push(line(b, contact ? contact(b) : null));
    room -= part.length;
    if (list.length > part.length) lines.push(`…и ещё ${list.length - part.length} — в кабинете.`);
    return part.length;
  };
  let shown = 0;
  shown += section(waiting.length ? `Ждут вашего ответа: ${waiting.length}.` : 'Ждут вашего ответа: нет.', waiting);
  shown += section(
    upcoming.length
      ? `Ближайшие ${CHAT_BOOKINGS_WINDOW_DAYS} дней: ${upcoming.length}.`
      : `Ближайшие ${CHAT_BOOKINGS_WINDOW_DAYS} дней: броней нет.`,
    upcoming,
  );
  if (past.length) shown += section(`Прошли — отметьте, как всё прошло: ${past.length}.`, past);
  const buttons = bookingButtons(rows, nowMs);
  lines.push(buttons.length
    ? `Ответить — кнопками ниже (вопрос, затем «Да») или в кабинете, раздел «Свои туры»: ${ownUrl()}`
    : `Подтвердить или отклонить бронь — в кабинете, раздел «Свои туры»: ${ownUrl()}`);
  lines.push(...tail);
  return { text: lines.join('\n'), shown, buttons };
}

/** MAX: с именем и телефоном туриста. `pd` — в тексте есть контакт хоть одной брони. */
export function guideBookingsMaxText(
  rows: readonly OwnBooking[],
  nowMs: number,
): { text: string; pd: boolean; buttons: MenuButton[][] } {
  const { text, shown, buttons } = bookingsText(rows, nowMs, contactOf, []);
  return { text, pd: shown > 0, buttons };
}

/** Telegram: без имени, телефона и почты — по закону о ПД их принимает только MAX. */
export function guideBookingsTelegramText(rows: readonly OwnBookingNoPd[], nowMs: number): { text: string; buttons: MenuButton[][] } {
  const { text, buttons } = bookingsText(rows, nowMs, null, ['Имя и телефон туриста — в MAX и в кабинете.']);
  return { text, buttons };
}

export const GUIDE_BOOKINGS_UNREAD = 'Брони не прочитались — база не ответила. Это не «броней нет». Раздел на сайте: ';
export const GUIDE_TOURS_UNREAD = 'Туры не прочитались — база не ответила. Это не «туров нет». Раздел на сайте: ';

/** Экран «Брони» для канала. Отказ базы — словами, в лог — SQLSTATE. */
export async function guideBookingsScreen(
  partnerId: string,
  channel: 'max' | 'telegram',
  nowMs: number,
): Promise<{ text: string; pd: boolean; buttons: MenuButton[][] }> {
  let rows: OwnBooking[];
  try {
    rows = await loadOwnBookings(partnerId);
  } catch (err) {
    logSwallowedFailure('guide-chat', 'брони гида для чата', err);
    return { text: `${GUIDE_BOOKINGS_UNREAD}${ownUrl()}`, pd: false, buttons: [] };
  }
  if (channel === 'max') return guideBookingsMaxText(rows, nowMs);
  return { ...guideBookingsTelegramText(rows.map(withoutPd), nowMs), pd: false };
}

/** «Мои туры»: на сайте или черновик (подписи кабинета) и сколько открытых дат. */
export function guideToursText(tours: readonly OwnTour[]): string {
  if (tours.length === 0) {
    return `Своих туров в кабинете нет. «Новый тур» — кнопкой ниже или фразой «новый тур: …». Раздел «Свои туры»: ${ownUrl()}`;
  }
  const lines = ['<b>Мои туры</b>'];
  for (const t of tours.slice(0, SHOWN)) {
    const state = storefrontState(t);
    const dates = state === 'on' ? ` · открытых дат: ${t.open_dates}` : '';
    lines.push(`• ${escapeHtml(t.title)} — ${STOREFRONT_LABELS[state]}${dates}`);
  }
  if (tours.length > SHOWN) lines.push(`…и ещё ${tours.length - SHOWN} — в кабинете.`);
  // Те же слова, что у раздела «Свои туры» на сайте.
  // Черновик гид выводит на сайт сам (31.10): у тура — чего не хватает и «Опубликовать».
  if (tours.some((t) => storefrontState(t) === 'draft')) {
    lines.push('Черновики туристы не видят: нажмите тур — там видно, чего не хватает до сайта, и кнопка «Опубликовать».');
  }
  // Правка текста и цены — в чате (30.10, lib/guides/tour-edit): «было → станет», пишет кнопка «Сохранить».
  lines.push('Нажмите тур ниже: даты кнопками, текст и цена. Или одним сообщением: «Горелый: описание: …», «Горелый: цена 16000» — покажу, что было и что станет, сохранит кнопка «Сохранить».');
  lines.push(`Открыть даты, брони и заявки — в разделе «Свои туры»: ${ownUrl()}`);
  return lines.join('\n');
}

/**
 * Кнопка каждого тура под «Моими турами» — в экран тура кабинета в чате
 * (`cb:u:<тур>`, lib/guides/tour-edit, 30.10): даты кнопками, правка текста
 * и цены, страница на сайте. В payload — только номер тура.
 */
export function guideTourButtons(tours: readonly OwnTour[]): MenuButton[][] {
  return [
    ...tours.slice(0, SHOWN).map((t) => [{
      text: t.title.length > 40 ? `${t.title.slice(0, 39).trimEnd()}…` : t.title,
      payload: cabinetPayload.tour(t.id),
    }]),
    // Новый тур (31.10): подсказка формы, создаёт только кнопка «Создать черновик».
    [{ text: 'Новый тур', payload: cabinetPayload.tourNew() }],
  ];
}

/** «Мои туры» с кнопками туров. Отказ базы — словами, без кнопок. */
export async function guideToursMenuScreen(partnerId: string): Promise<{ text: string; buttons: MenuButton[][] }> {
  try {
    const tours = await loadOwnTours(partnerId);
    return { text: guideToursText(tours), buttons: guideTourButtons(tours) };
  } catch (err) {
    logSwallowedFailure('guide-chat', 'туры гида для чата', err);
    return { text: `${GUIDE_TOURS_UNREAD}${ownUrl()}`, buttons: [] };
  }
}

export async function guideToursScreen(partnerId: string): Promise<string> {
  return (await guideToursMenuScreen(partnerId)).text;
}
