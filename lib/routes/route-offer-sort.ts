/**
 * Туры на карточке маршрута: порядок и выбор туриста.
 *
 * По умолчанию (`order`) — порядок сервера, то есть правило 1в (слово
 * владельца 29.10, lib/tours/offer-order): сначала туры со свободными местами
 * по ближайшему выезду, остальные — жребием дня. До 29.10 клиент по умолчанию
 * сортировал по цене, а сервер — по `marketplace_score` вьюхи, в который
 * входила комиссия платформы; кнопка «Рейтинг» поднимала туры по оценке, у
 * большинства туров которой нет вовсе.
 *
 * Цену, дату и места включает сам турист. Сортировка устойчива: равные идут
 * порядком сервера, а не случайно. Цены и даты, которых нет, — в конце:
 * «не знаем» не дешевле и не раньше.
 *
 * Чистый модуль. Сторож: tests/unit/route-offers-order.test.tsx.
 */

export type RouteOfferSort = 'order' | 'price' | 'date' | 'slots';

export const ROUTE_OFFER_SORTS: readonly RouteOfferSort[] = ['order', 'price', 'date', 'slots'];

export interface RouteOfferSortable {
  effectivePrice: number | null;
  priceBase: number | null;
  nextDeparture: string | null;
  nextSlots: number | null;
}

function priceOf(o: RouteOfferSortable): number | null {
  const p = o.effectivePrice ?? o.priceBase;
  return p != null && Number.isFinite(p) ? p : null;
}

function dateOf(o: RouteOfferSortable): number | null {
  if (!o.nextDeparture) return null;
  const t = new Date(o.nextDeparture).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Ключ «чем меньше, тем выше»; null — в конец при любом выборе. */
function keyed<T>(rows: readonly T[], key: (r: T) => number | null): T[] {
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if ((ka === null) !== (kb === null)) return ka === null ? 1 : -1;
    if (ka === null || kb === null) return 0;
    return ka - kb;
  });
}

export function sortRouteOffers<T extends RouteOfferSortable>(offers: readonly T[], sortBy: RouteOfferSort): T[] {
  switch (sortBy) {
    case 'price': return keyed(offers, priceOf);
    case 'date': return keyed(offers, dateOf);
    case 'slots': return keyed(offers, (o) => (o.nextSlots != null && o.nextSlots > 0 ? -o.nextSlots : null));
    case 'order':
    default: return [...offers];
  }
}
