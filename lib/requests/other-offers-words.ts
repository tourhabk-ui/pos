/**
 * lib/requests/other-offers-words.ts — слова о «других компаниях к месту на
 * дату» после отказа (план «после отказа», этап 4а).
 *
 * Одни слова на сообщение человеку в чате (answer-notice-text), страницу
 * заявки (components/requests/RequestOtherOffers) и письмо менеджеру: если бы
 * каждая поверхность писала их сама, чат сказал бы «места есть», а страница —
 * «свободно», и это читалось бы как два разных обещания.
 *
 * Без базы и без серверных модулей: файл читает и клиентская страница.
 * Сторожа: tests/unit/answer-notice.test.ts (сообщение),
 * tests/unit/request-other-offers.test.tsx (страница — рендером).
 */
import { plural } from '@/lib/home/data-freshness';

/**
 * `calendar` — в календаре тура на дату хватает мест на всю группу;
 * `by_request` — календаря у тура нет, дату подтверждает оператор.
 */
export type OtherOfferSeats = 'calendar' | 'by_request';

/**
 * Что это за список и кому уйдут данные. «Может принять» — это календарь, а
 * не слово компании: без этой строки список читался бы как обещание.
 */
export const OTHER_OFFERS_NOT_ANSWER_RU =
  'Это не ответ этих компаний: места и дату каждая подтверждает сама. '
  + 'Заявку вы оставляете сами по ссылке — имя и телефон получит только та компания, которой вы её оставите.';

/** Что известно о местах у тура другой компании на дату заявки. `people` — на сколько человек считали; null — не записано. */
export function otherOfferSeatsWords(seats: OtherOfferSeats, people: number | null): string {
  return seats === 'calendar'
    ? `в календаре на эту дату места${people ? ` на ${people} чел.` : ''} есть`
    : 'расписания на Ведаре нет — дату подтверждает оператор';
}

/** «у компании к этому месту ещё 2 тура»; нет других — пустая строка. */
export function otherOfferMoreToursWords(n: number): string {
  return n > 0 ? `у компании к этому месту ещё ${n} ${plural(n, 'тур', 'тура', 'туров')}` : '';
}

/** «Ещё 3 компании»; нет — пустая строка. */
export function otherOffersMoreCompaniesWords(n: number): string {
  return n > 0 ? `Ещё ${n} ${plural(n, 'компания', 'компании', 'компаний')}` : '';
}
