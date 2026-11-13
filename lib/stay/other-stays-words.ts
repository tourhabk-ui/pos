/**
 * lib/stay/other-stays-words.ts — слова о «другом жилье на ваши даты» после
 * ответа хозяина «Занято» (план «после отказа», этап 5).
 *
 * Одни слова на сообщение гостю в чат, страницу заявки и строку менеджеру:
 * если бы каждая поверхность писала их сама, чат сказал бы «свободно», а
 * страница — «места есть», и это читалось бы как два разных обещания.
 *
 * Без базы и без серверных модулей: файл читает и клиентская страница.
 * Сторожа: tests/unit/other-stays.test.ts (сообщение),
 * tests/unit/request-other-stays.test.tsx (страница — рендером).
 */
import { plural } from '@/lib/home/data-freshness';
import { LODGING_OPTIONS_PER_STAY } from '@/lib/planner/trip-extras';
import { ACCOMMODATION_TYPE_LABELS, type AccommodationType } from '@/lib/stay/accommodation-types';

export type OtherStayDatesWord = 'calendar' | 'by_request';

/**
 * Что это за список и кому уйдут данные. Без этой строки список читался бы
 * как обещание Ведара: «свободно» — это календарь, а не слово хозяина.
 */
export const OTHER_STAYS_NOT_ANSWER_RU =
  'Это не ответ хозяев этих объектов: даты и цену каждый подтверждает сам. '
  + 'Заявку вы оставляете сами по ссылке — имя и телефон получит только тот хозяин, которому вы её оставите.';

/**
 * Правило порядка — словами (§0): то же, что у подбора жилья в плане поездки
 * (LODGING_FOR_STAY_SQL и REQUEST_LODGING_FOR_STAY_SQL). У двух групп ключи
 * разные, и названы оба: у жилья «по заявке хозяину» оценка в порядок не входит.
 */
export const OTHER_STAYS_ORDER_NOTE_RU =
  'Порядок: сначала жильё, где по календарю Ведара номера свободны на все ваши ночи (проверенные Ведаром, затем по оценке гостей и цене за ночь), '
  + 'затем жильё, где даты подтверждает хозяин (проверенные Ведаром, затем по цене за ночь). Место в списке не продаётся.';

/**
 * Список неполон по построению: подбор плана отдаёт не больше
 * LODGING_OPTIONS_PER_STAY объектов каждого вида. Молча обрезанный список
 * читался бы как «это всё, что есть».
 */
export const OTHER_STAYS_LIMIT_NOTE_RU =
  `В списке не больше ${LODGING_OPTIONS_PER_STAY} объектов каждого вида — остальное жильё смотрите в каталоге.`;

function rub(n: number): string {
  return `${Math.round(n).toLocaleString('ru-RU').replace(/ | /g, ' ')} ₽`;
}

/** «Гостевой дом»; незнакомый тип — пустая строка, а не слог из базы. */
export function otherStayTypeWords(type: string): string {
  return ACCOMMODATION_TYPE_LABELS[type as AccommodationType] ?? '';
}

/**
 * Что известно о ночах и цене у объекта. `guests` — на сколько гостей считали;
 * null — в заявке не записано. Цена — факт в строке, на место в списке сама по
 * себе не влияет иначе, чем названо в правиле порядка.
 */
export function otherStayDatesWords(
  s: { dates: OtherStayDatesWord; priceFrom: number | null; stayTotal: number | null }, guests: number | null,
): string {
  if (s.dates === 'calendar') {
    if (s.stayTotal !== null) {
      return `в календаре на эти ночи номера${guests ? ` на ${guests} ${plural(guests, 'гостя', 'гостей', 'гостей')}` : ''} есть — ${rub(s.stayTotal)} за все ночи`;
    }
    return `в календаре на эти ночи есть свободные номера; поместится ли вся группа — подтверждает хозяин${s.priceFrom !== null ? `; от ${rub(s.priceFrom)} за ночь` : ''}`;
  }
  return `номеров на Ведаре нет — даты и цену подтверждает хозяин${s.priceFrom !== null ? `; от ${rub(s.priceFrom)} за ночь` : ''}`;
}
