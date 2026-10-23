/**
 * Заявка на прокат автомобиля — тексты и структурные поля лида (витрина
 * проката 23.10, схема 1317). По образцу заявки на машину перевозчика
 * (lib/transfers/charter-request): модуль чистый — ни базы, ни сети; запись,
 * даты и согласие — в rental-request-service и роуте.
 *
 * Чего здесь нет намеренно (§4.0):
 *   · итоговой суммы. Прайс называет цену за сутки — иногда «от», — но не
 *     называет, что в неё входит, есть ли минимальный срок и сколько стоит
 *     водитель; умножить на число дней значило бы выдать догадку за цену.
 *     Называется строка прайса как есть;
 *   · занятости для туриста. Ответ прокатчика «Беру» пишет его календарь
 *     (`rental_car_busy`, source `request`); витрина и этот ответ человеку
 *     календарь не читают — «машина закреплена» была бы обещанием, которого
 *     прайс не даёт. Подтверждает менеджер;
 *   · контактов прокатчика в ответе человеку. Они уходят менеджеру в заявку.
 */

import { driverWord, priceOnScreen, rentalPagePath, type RentalCompany, type RentalOffer } from '@/lib/rental/rental-format';

/** Чем начинается комментарий лида: по этому префиксу ищется повтор и узнаётся заявка на прокат. */
export const RENTAL_LEAD_TAG = '[Заявка на прокат]';

/** Сколько дней вперёд принимаем дату начала аренды: прайс годовой, дальше года прокатчик не загадывает. */
export const RENTAL_MAX_DAYS_AHEAD = 400;
/** Самая длинная аренда в одной заявке, дней. */
export const RENTAL_MAX_DAYS = 30;

export interface RentalRequestFacts {
  company: Pick<RentalCompany, 'partnerId' | 'slug' | 'name' | 'phone'>;
  offer: RentalOffer;
  dateFrom: string;
  dateTo: string;
  /** Календарных дней аренды: с dateFrom по dateTo включительно. */
  days: number;
  comment: string | null;
}

/** Дней аренды по датам: с 10-го по 12-е — три дня. Даты уже проверены. */
export function rentalDays(dateFrom: string, dateTo: string): number {
  const ms = Date.parse(`${dateTo}T00:00:00Z`) - Date.parse(`${dateFrom}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/**
 * Префикс комментария лида: по нему ищется повтор заявки того же человека
 * (телефон + прокатчик + дата начала за сутки).
 */
export function rentalDedupPrefix(companyName: string, dateFrom: string): string {
  return `${RENTAL_LEAD_TAG} «${companyName}», с ${dateFrom},`;
}

/** Строка прайса словами для менеджера: «Toyota Land Cruiser Prado — от 25 000 ₽/сутки, без водителя». */
function offerWords(o: RentalOffer): string {
  return `${o.title} — ${priceOnScreen(o)}, ${driverWord(o.driver)}`;
}

function daysWord(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'день';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'дня';
  return 'дней';
}

/**
 * Комментарий лида — то, что видит менеджер в уведомлении и в админке.
 * Телефон прокатчика здесь есть намеренно: менеджеру нужно кому звонить.
 */
export function rentalLeadComment(f: RentalRequestFacts): string {
  const tail: string[] = [];
  tail.push(`по ${f.dateTo}`, `${f.days} ${daysWord(f.days)}`);
  tail.push(`машина по прайсу: ${offerWords(f.offer)}`);
  if (f.offer.priceIsFrom) tail.push('цена «от» — точную назовёт прокатчик');
  if (f.offer.depositRub !== null) tail.push(`залог по прайсу ${f.offer.depositRub} руб`);
  tail.push('что входит в цену, минимальный срок и требования к водителю на платформе не записаны — уточнить у прокатчика');
  if (f.company.phone) tail.push(`телефон прокатчика: ${f.company.phone}`);
  if (f.comment) tail.push(`пожелания: ${f.comment}`);
  return `${rentalDedupPrefix(f.company.name, f.dateFrom)} ${tail.join('; ')}.`;
}

/**
 * Факты заявки для САМОГО прокатчика (личное уведомление в MAX/Telegram,
 * lib/notifications/partner-request-notify): без его же телефона и без заметок
 * менеджеру. ПД заказчика здесь нет: их добавляет уведомление в текст для MAX.
 */
export function rentalRequestLines(f: RentalRequestFacts): string[] {
  const lines = [
    `Машина: ${offerWords(f.offer)}`,
    `Даты: с ${f.dateFrom} по ${f.dateTo}, ${f.days} ${daysWord(f.days)}`,
  ];
  if (f.offer.priceIsFrom) lines.push('Цена в прайсе «от» — точную называете вы');
  if (f.offer.depositRub !== null) lines.push(`Залог по прайсу: ${f.offer.depositRub} руб`);
  return lines;
}

/** Чьей дверью пришла заявка. Пока дверь одна — форма на странице прокатчика. */
export type RentalDoor = 'form' | 'mcp';

/** Структурные поля в source_data лида — чтобы заявку можно было разобрать, не парся комментарий. */
export function rentalSourceData(f: RentalRequestFacts, door: RentalDoor = 'form'): Record<string, unknown> {
  return {
    source: door === 'form' ? 'car_rental_page' : 'mcp',
    kind: 'car_rental',
    company_id: f.company.partnerId,
    company_slug: f.company.slug,
    offer_id: f.offer.id,
    offer_title: f.offer.title,
    date_from: f.dateFrom,
    date_to: f.dateTo,
    days: f.days,
    price_rub_per_day: f.offer.priceRubPerDay,
    price_is_from: f.offer.priceIsFrom,
    driver: f.offer.driver,
  };
}

/**
 * Ответ человеку после отправки. Один и тот же для новой заявки и для повтора:
 * любое различие — оракул «этот телефон уже просил эту машину на эту дату».
 */
export function rentalAcceptedText(f: RentalRequestFacts, baseUrl: string): string {
  return `Заявка на прокат принята: «${f.company.name}», ${f.offer.title}, с ${f.dateFrom} по ${f.dateTo} (${f.days} ${daysWord(f.days)}).`
    + ` По прайсу: ${offerWords(f.offer)}.${f.offer.priceIsFrom ? ' Цена «от» — точную назовёт прокатчик.' : ''}`
    + ' Что входит в цену, минимальный срок и требования к водителю на платформе не записаны — это уточняется у прокатчика; итоговой суммы платформа не называет.'
    + ' Машина этим НЕ закреплена: менеджер Ведара свяжется по телефону, согласует машину с прокатчиком и подтвердит.'
    + ' Это заявка, не оплата: расчёт с прокатчиком напрямую, через платформу машина не оплачивается.'
    + ` Страница прокатчика: ${baseUrl}${rentalPagePath(f.company.slug)}`;
}
