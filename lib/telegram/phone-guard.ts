/**
 * Телефон туриста в Telegram-боте не принимается (решение владельца 22.11
 * 19:09, pd-guard): заявки с телефоном — только на сайте и в MAX.
 *
 * Номер, присланный в чат, не сохраняется и не уходит дальше: обычное
 * сообщение с номером получает ответ «телефон — на сайте или в MAX», а
 * сообщение о беде идёт Кузьмичу (блок 112) с номером, заменённым на
 * «[номер скрыт]». В строку восстановления апдейта номер тоже не попадает.
 *
 * Номер распознаёт тот же детектор, что стоит на границе ПД перед моделью
 * (`redactPII`): он уже отличает телефоны от диапазонов дат, сумм и
 * координат. Почта в маскированном тексте тоже скрывается.
 */

import { redactPII } from '@/lib/security/pii-redact';

const DETECTOR_PHONE = '[телефон]';

export const PHONE_MASK = '[номер скрыт]';
export const SITE_REQUEST_URL = 'https://vedarai.ru/contact';
export const MAX_KUZMICH_URL = 'https://max.ru/id4101147649_biz';

const count = (text: string, part: string): number => text.split(part).length - 1;

/** Есть ли в тексте номер телефона. */
export function hasPhone(text: string): boolean {
  if (!text) return false;
  return count(redactPII(text), DETECTOR_PHONE) > count(text, DETECTOR_PHONE);
}

/** Текст с номерами, заменёнными на «[номер скрыт]» (почта — на «[email]»). */
export function maskPhones(text: string): string {
  if (!text) return text;
  return redactPII(text).split(DETECTOR_PHONE).join(PHONE_MASK);
}

export const TG_PHONE_REFUSAL_TEXT = [
  'Телефон в Telegram не принимаю и не сохраняю — так мы бережём ваши данные.',
  '',
  'Оставить заявку с телефоном можно на сайте или в MAX у Кузьмича — там оператор получит ваши контакты.',
  'Заявка — не бронь: места подтверждает оператор, оплаты на сайте нет.',
].join('\n');

/** Кнопки-ссылки под отказом: сайт и MAX. */
export const TG_PHONE_REFUSAL_BUTTONS: Array<Array<{ text: string; url: string }>> = [
  [{ text: 'Оставить заявку на сайте', url: SITE_REQUEST_URL }],
  [{ text: 'Кузьмич в MAX', url: MAX_KUZMICH_URL }],
];
