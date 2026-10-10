/**
 * lib/stay/stay-request.ts — заявка хозяину жилья без своей брони (1206).
 *
 * Решение владельца 10.10: «для броней нужна удобная форма для приложения
 * MAX». У «Кутхи» нет ни номеров, ни аккаунта хозяина, ни сайта брони — есть
 * телефон. Гость заполняет на карточке даты, сколько человек, имя и телефон;
 * хозяин получает это ОДНИМ сообщением в MAX и перезванивает сам.
 *
 * Это не бронь: даты и цену подтверждает хозяин, платформа оплату не
 * принимает. Поэтому в сообщении нет «забронировано», а в ответе гостю —
 * «заявка передана», и только когда она действительно дошла.
 *
 * Куда дошло — три исхода, а не два (§4.0):
 *   owner    — хозяину в MAX (его адрес — partners.max_chat_id, пишется ботом);
 *   platform — хозяину не дошло (не подключён или MAX отказал), но дошло
 *              оператору платформы — он перезвонит хозяину сам;
 *   none     — не дошло никому: гостю говорится прямо и даётся телефон.
 *
 * ПД гостя уходят только в MAX (sendPdAlert); в Telegram — заглушка без них.
 * Сторож: tests/unit/stay-request.test.ts.
 */

import { escapeHtml } from '@/lib/text/escape-html';

/** Сколько ночей можно спросить одной заявкой: больше — уже не заявка, а разговор. */
export const MAX_REQUEST_NIGHTS = 60;

export type StayRequestDelivery = 'owner' | 'platform' | 'none';

export interface StayRequestMessage {
  accommodationName: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  guests: number;
  guestName: string;
  guestPhone: string;
  comment: string | null;
  /** Цена за сутки от и до — как записана у объекта; null — не названа. */
  priceFrom: number | null;
  priceTo: number | null;
}

/** 'YYYY-MM-DD' → 'DD.MM.YYYY'. */
export function ruDate(d: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.split('-').reverse().join('.') : d;
}

/** Число ночей между датами; null — даты не по порядку или не даты. */
export function nightsBetween(checkIn: string, checkOut: string): number | null {
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const n = Math.round((b - a) / 86_400_000);
  return n >= 1 ? n : null;
}

const money = (v: number) => new Intl.NumberFormat('ru-RU').format(v);

/** Где администратор видит заявку целиком — вкладка «Заявки гостей» (1213). */
export const STAY_REQUESTS_ADMIN_PATH = '/hub/admin/accommodations#requests';

/**
 * Текст с ПД (только для MAX) и две заглушки без ПД (для Telegram).
 *
 * Заглушка уходит ровно тогда, когда MAX НЕ сработал, — значит, обещать в ней
 * «имя и телефон — в MAX» нельзя: так было до 10.10, и владелец получил
 * заглушку, не найдя заявки ни в MAX, ни в админке. Заглушек две, потому что
 * у получателей разный путь к телефону гостя:
 *   - платформе — вкладка заявок в админке (STAY_REQUESTS_ADMIN_PATH);
 *   - хозяину — кабинета у него может не быть вовсе (у «Кутхи» его нет),
 *     поэтому ему говорится, как получать заявки целиком.
 * Всё, что ввёл гость, экранируется: текст уходит как HTML.
 */
export function stayRequestTexts(m: StayRequestMessage): { text: string; ownerStub: string; platformStub: string } {
  const price = m.priceFrom != null
    ? (m.priceTo != null && m.priceTo !== m.priceFrom
      ? `Цена за сутки на карточке: ${money(m.priceFrom)}–${money(m.priceTo)} ₽`
      : `Цена за сутки на карточке: ${money(m.priceFrom)} ₽`)
    : null;
  const common = [
    `<b>Заявка на жильё с Ведара: ${escapeHtml(m.accommodationName)}</b>`,
    `Заезд: ${ruDate(m.checkIn)} · Выезд: ${ruDate(m.checkOut)} · ночей: ${m.nights}`,
    `Гостей: ${m.guests}`,
    price,
  ].filter(Boolean) as string[];
  const contacts = [
    `Гость: ${escapeHtml(m.guestName)}`,
    `Телефон: ${escapeHtml(m.guestPhone)}`,
    m.comment ? `Комментарий: ${escapeHtml(m.comment)}` : null,
  ].filter(Boolean) as string[];
  const tail = 'Свяжитесь с гостем напрямую: даты и цену подтверждаете вы. Платформа оплату не принимает.';
  return {
    text: [...common, ...contacts, '', tail].join('\n'),
    ownerStub: [
      ...common,
      'Имя и телефон гостя в Telegram не передаются. Чтобы получать заявки целиком, подключите MAX: ссылку на бота пришлёт администратор Ведара.',
    ].join('\n'),
    platformStub: [
      ...common,
      'MAX не сработал: имя и телефон гостя — в админке, Жильё → «Заявки гостей».',
    ].join('\n'),
  };
}

export type StayOwnerChannel = 'max' | 'telegram-stub' | 'none' | 'no_address';
export type StayPlatformChannel = 'max' | 'telegram-stub' | 'none';

/**
 * Исход доставки словами — для вкладки заявок. NULL канала — заявка до 1213
 * или запись исхода не удалась: «не записано», а не «не дошло» (§4.0).
 */
export function ownerDeliveryLabel(ch: string | null): { text: string; ok: boolean | null } {
  switch (ch) {
    case 'max': return { text: 'Хозяину в MAX — с именем и телефоном', ok: true };
    case 'telegram-stub': return { text: 'Хозяину — только заглушка в Telegram, без имени и телефона', ok: false };
    case 'none': return { text: 'Хозяину не дошло', ok: false };
    case 'no_address': return { text: 'Хозяин не подключён к боту — слать было некуда', ok: false };
    default: return { text: 'Исход для хозяина не записан', ok: null };
  }
}

export function platformDeliveryLabel(ch: string | null): { text: string; ok: boolean | null } {
  switch (ch) {
    case 'max': return { text: 'Платформе в MAX — с именем и телефоном', ok: true };
    case 'telegram-stub': return { text: 'Платформе — только заглушка в Telegram (MAX не сработал)', ok: false };
    case 'none': return { text: 'Платформе не дошло', ok: false };
    default: return { text: 'Исход для платформы не записан', ok: null };
  }
}
