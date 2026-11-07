/**
 * Слова «Что ещё нужно» к плану — одни на экране планера
 * (app/planner/TripExtrasSection) и в ответе make_trip_plan
 * (lib/kuzmich/plan-offers). Две поверхности одного подбора не должны
 * называть одну цену по-разному: «от 25 000 ₽ за день» на экране и «25 000 ₽
 * в сутки» агенту — уже два разных ответа.
 *
 * Чистые функции, без JSX и без базы.
 */

import type { StayPrice } from '@/lib/planner/trip-extras';

export function fmtRub(n: number): string {
  return `${new Intl.NumberFormat('ru-RU').format(n)} ₽`;
}

function ruPlural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

export function nightsRu(n: number): string {
  return ruPlural(n, 'ночь', 'ночи', 'ночей');
}

export function roomsRu(n: number): string {
  return ruPlural(n, 'номер', 'номера', 'номеров');
}

export function directionsRu(n: number): string {
  return ruPlural(n, 'направление', 'направления', 'направлений');
}

export function carsRu(n: number): string {
  return ruPlural(n, 'машина', 'машины', 'машин');
}

/** Что нужно от перевозчика для строки цены (форма CharterOffer). */
export interface CharterPriceFacts {
  priceFromRub: number | null;
  destinations: number;
  /** Нет поля — план, сохранённый офлайн до 1292: такой цены нет. */
  hourRub?: number | null;
  dayRub?: number | null;
  ratesFrom?: boolean;
}

/**
 * Цена перевозчика одной строкой: «от N за машину · M направлений в прайсе»,
 * у цены за время работы (1292) — «N в час · M за день за машину»; цены нет —
 * «назовёт перевозчик».
 */
export function charterOfferPrice(o: CharterPriceFacts): string {
  if (o.priceFromRub !== null) return `от ${fmtRub(o.priceFromRub)} за машину · ${directionsRu(o.destinations)} в прайсе`;
  // Тарифы на разные виды машин (1318) — названа самая низкая, и это «от».
  const from = o.ratesFrom === true ? 'от ' : '';
  const byTime = [
    typeof o.hourRub === 'number' ? `${from}${fmtRub(o.hourRub)} в час` : null,
    typeof o.dayRub === 'number' ? `${from}${fmtRub(o.dayRub)} за день` : null,
  ].filter(Boolean);
  if (byTime.length > 0) return `${byTime.join(' · ')} за машину · направление — ваше`;
  return 'Цену машины назовёт перевозчик';
}

/** Что нужно от прокатчика для строки (форма RentalOfferSummary). */
export interface RentalLineFacts {
  priceFromRub: number | null;
  offers: number;
  driverOptional: boolean;
}

/** Строка прокатчика: цена «от» за сутки без водителя; нет цены — не выдумывается. */
export function rentalOfferLine(o: RentalLineFacts): string {
  const price = o.priceFromRub !== null ? `от ${fmtRub(o.priceFromRub)} за сутки без водителя` : 'Цену назовёт прокатчик';
  const driver = o.driverOptional ? ' · водитель по желанию, цена отдельно' : '';
  return `${price} · ${carsRu(o.offers)} в прайсе${driver}`;
}

/**
 * Как группа встаёт в номера объекта на стоянку — по правилу брони
 * (stayPriceForGroup): тип номеров и сколько их; не помещается в один тип —
 * раскладку решает хозяин; цены на группу нет — её посчитает карточка.
 */
export function stayRoomsLine(stay: StayPrice | undefined): string {
  if (stay?.kind === 'priced') return `${roomsRu(stay.rooms)} «${stay.roomName}», до ${stay.maxGuests} гостей в номере`;
  if (stay?.kind === 'no_fit') return 'Группа целиком в один тип номеров не помещается — номера подберёт хозяин';
  return 'Цену на группу посчитаем в карточке объекта';
}
