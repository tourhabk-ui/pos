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

/**
 * Текст хозяину (с ПД — только для MAX) и заглушка без ПД (для Telegram).
 * Всё, что ввёл гость, экранируется: текст уходит как HTML.
 */
export function stayRequestTexts(m: StayRequestMessage): { text: string; stub: string } {
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
    stub: [...common, 'Имя и телефон гостя — в MAX.', '', tail].join('\n'),
  };
}
