/**
 * Телефон туриста в Telegram-боте не принимается (решение владельца 22.11
 * 19:09, pd-guard): заявки с телефоном — только на сайте и в MAX.
 *
 * Номер, присланный в чат, не сохраняется и не уходит дальше: обычное
 * сообщение с номером получает ответ «телефон — на сайте или в MAX», а
 * сообщение о беде идёт Кузьмичу (блок 112) с номером, заменённым на
 * «[номер скрыт]». В строку восстановления апдейта номер тоже не попадает.
 *
 * Номер — от 10 до 15 цифр подряд с пробелами, дефисами, скобками и «+»:
 * так пишут российские и зарубежные мобильные. Даты (8 цифр) и цены не
 * задеваются.
 */

const CANDIDATE_RE = /\+?\d[\d\s\-().]{8,22}\d/g;
const MIN_DIGITS = 10;
const MAX_DIGITS = 15;

export const PHONE_MASK = '[номер скрыт]';
export const SITE_REQUEST_URL = 'https://vedarai.ru/contact';
export const MAX_KUZMICH_URL = 'https://max.ru/id4101147649_biz';

function isPhone(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '').length;
  return digits >= MIN_DIGITS && digits <= MAX_DIGITS;
}

/** Есть ли в тексте номер телефона. */
export function hasPhone(text: string): boolean {
  if (!text) return false;
  for (const m of text.matchAll(CANDIDATE_RE)) if (isPhone(m[0])) return true;
  return false;
}

/** Текст с номерами, заменёнными на «[номер скрыт]». */
export function maskPhones(text: string): string {
  if (!text) return text;
  return text.replace(CANDIDATE_RE, (m) => (isPhone(m) ? PHONE_MASK : m));
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
