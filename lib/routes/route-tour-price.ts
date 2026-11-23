/**
 * Цена маршрута — из его туров (слово владельца 18.11 «1»).
 *
 * У маршрута своей цены нет: маршрут — инструкция, тур — коммерция (§10).
 * До 17.11 каталог показывал «от N ₽» из `payload.price_from` — число со
 * статьи-источника, без тура за ним. Владелец снял его (17.11 «1 да»), а
 * затем вернул цену в каталог как цену туров: «иначе как выбирать».
 *
 * Правило одно на каталог, страницу категории и карточку маршрута:
 *
 *  - туры маршрута — те, что карточка показывает в блоке «Туры по маршруту»
 *    (`v_route_marketplace`: живые, опубликованные, компания на витрине);
 *  - тур ищется по ОБОИМ номерам маршрута. Номер карточки — номер вьюхи
 *    `COALESCE(ark_id, id)`, а тур привязан `agent_route_id` к номеру вьюхи
 *    своего времени. До 18.11 карточка искала туры только по `kamchatka_routes.id`
 *    и теряла туры маршрутов, у которых номера разошлись (тот же урок, что
 *    #3302: перепись 13.11 насчитала 77 таких маршрутов из 368);
 *  - цена тура — та, что на его карточке (§11): `base_price`. Вьюха отдаёт
 *    ещё `effective_price = COALESCE(price_old, base_price)`, а `price_old` —
 *    ЗАЧЁРКНУТАЯ старая цена (поле «Зачёркнутая» в кабинете). Карточка
 *    маршрута показывала её действующей ценой; теперь не показывает;
 *  - цена маршрута — самая низкая цена тура ЗА ЧЕЛОВЕКА. Цену за группу и за
 *    день с ценой с человека не сравнить, и «от» по ним было бы неправдой;
 *  - «от» — только когда таких туров несколько (правило #3487: у одного тура
 *    одно число, «от» ему дописывал бы форматтер).
 *
 * Тура с ценой за человека нет — цены нет (`null`), а не ноль: «не знаем» не
 * дешевле (§4.0). Сортировка по цене ставит такие маршруты в конец, фильтр по
 * цене их не пропускает.
 *
 * Сторож: tests/unit/route-tour-price.test.tsx.
 */
import { testPartnerIdSql } from '@/lib/partners/test-profile';

/** Единица цены, по которой у маршрута считается «от»: за человека. */
export const ROUTE_PRICE_UNIT = 'per_person';

/**
 * Цена тура так, как её показывает его карточка (§11): `base_price`.
 * Нет, ноль или не число — `null` (ноль невозможен по CHECK колонки).
 */
export function offerShownPrice(o: { priceBase: number | null | undefined }): number | null {
  const p = o.priceBase;
  return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null;
}

/**
 * Строки вьюхи `v_route_marketplace` (псевдоним `v`), относящиеся к маршруту
 * с номером карточки `arkId` (номер вьюхи `agent_route_knowledge`): по самому
 * номеру и по `kamchatka_routes.id` живой строки, чей `ark_id` равен ему.
 */
export function routeToursKeySql(v: string, arkId: string): string {
  return `(${v}.route_id = ${arkId}
       OR ${v}.route_id IN (SELECT krk.id FROM kamchatka_routes krk
                             WHERE krk.ark_id = ${arkId} AND krk.merged_into_id IS NULL))`;
}

/** Туры маршрута с ценой за человека: условие для подзапроса по `v_route_marketplace v`. */
function pricedToursWhere(arkAlias: string): string {
  return `${arkAlias}.kind = 'route'
         AND ${routeToursKeySql('v', `${arkAlias}.id`)}
         AND v.price_unit = '${ROUTE_PRICE_UNIT}'
         AND v.tour_price_base > 0
         AND NOT ${testPartnerIdSql('v.operator_id')}`;
}

/**
 * Самая низкая цена тура за человека по маршруту — скалярным выражением
 * (для WHERE: фильтр по цене стоит и в запросе счёта, где соединений нет).
 * У места и у маршрута без такого тура — NULL.
 */
export function routeTourPriceFromSql(arkAlias: string): string {
  return `(SELECT MIN(v.tour_price_base) FROM v_route_marketplace v
            WHERE ${pricedToursWhere(arkAlias)})`;
}

/**
 * То же соединением: `price_from` и `tours` (сколько туров с ценой за человека)
 * под псевдонимом `alias`. Для SELECT и ORDER BY.
 */
export function routeTourPriceLateralSql(arkAlias: string, alias: string): string {
  return `LEFT JOIN LATERAL (
         SELECT MIN(v.tour_price_base) AS price_from, COUNT(*)::int AS tours
           FROM v_route_marketplace v
          WHERE ${pricedToursWhere(arkAlias)}
       ) ${alias} ON TRUE`;
}

/** Цена маршрута в данных каталога: самая низкая цена тура за человека и число таких туров. */
export interface RouteTourPrice {
  priceFrom: number;
  tours: number;
}

/** Строка запроса → цена маршрута; цены нет — `null`. */
export function routeTourPriceOf(priceFrom: unknown, tours: unknown): RouteTourPrice | null {
  const p = priceFrom == null ? NaN : Number(priceFrom);
  if (!Number.isFinite(p) || p <= 0) return null;
  const n = Number(tours);
  return { priceFrom: p, tours: Number.isInteger(n) && n > 0 ? n : 1 };
}

/** «из 2 туров», «из 21 тура»: родительный падеж после «из». */
function fromTours(n: number): string {
  return `из ${n} ${n % 10 === 1 && n % 100 !== 11 ? 'тура' : 'туров'}`;
}

/**
 * Слова цены маршрута для карточки каталога: «от 18 000 ₽ за человека» и
 * подпись, откуда цена, — «самая низкая из 3 туров» / «цена тура».
 * Цены нет — `null`: вызывающий ничего не рисует.
 */
export function routeTourPriceWords(price: RouteTourPrice | null | undefined): { price: string; note: string } | null {
  if (!price) return null;
  const sum = `${price.priceFrom.toLocaleString('ru-RU')} ₽ за человека`;
  return price.tours > 1
    ? { price: `от ${sum}`, note: `самая низкая ${fromTours(price.tours)}` }
    : { price: sum, note: 'цена тура' };
}

/** Подпись к сортировке и фильтру по цене на странице каталога. */
export const ROUTE_PRICE_NOTE_RU =
  'Цена маршрута — самая низкая цена его тура за человека. Маршрута без такого тура в фильтре по цене нет, в сортировке по цене он в конце.';
