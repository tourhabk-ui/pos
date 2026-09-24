/**
 * Сумма брони тура по единице цены — одно правило на все двери.
 *
 * `operator_tours.price_unit` говорит, ЗА ЧТО стоит `base_price`:
 *
 *   per_person          — за человека:        цена × участники
 *   per_tour            — за группу целиком:  цена (сколько бы ни ехало)
 *   per_day_per_person  — за человека в день: цена × участники × дни
 *
 * До 24.09 каждая дверь бронирования (форма тура, корзина, Кузьмич, оплата
 * картой, агентский и операторский API) считала `base_price × participants`
 * сама и одинаково неверно для двух единиц из трёх: группа из четырёх на туре
 * «за группу» получала в заявке, письме и U-ON сумму вчетверо больше, а тур
 * «за день» стоил как однодневный. Решение владельца: «сделай цену за группу
 * правильной».
 *
 * NULL и незнакомое значение — `per_person`: это DEFAULT колонки (миграция
 * 056), то есть то, что база сама пишет, когда оператор единицу не указал.
 * Дни — `tourDurationDays` (lib/bookings/duration.ts), то же правило, по
 * которому бронь занимает календарь: два разных «сколько дней» у одной брони
 * разошлись бы в сумме и в занятости.
 *
 * Модуль чистый — без БД, его импортируют и сервер, и клиентские формы: сумма
 * на экране и сумма в заявке обязаны совпадать до рубля.
 */
import { tourDurationDays, type TourDurationSource } from '@/lib/bookings/duration';

export type PriceUnit = 'per_person' | 'per_tour' | 'per_day_per_person';

export function normalizePriceUnit(unit: string | null | undefined): PriceUnit {
  return unit === 'per_tour' || unit === 'per_day_per_person' ? unit : 'per_person';
}

export interface BookingTotalInput {
  basePrice: number;
  priceUnit: string | null | undefined;
  participants: number;
  /** Длительность тура — нужна только для per_day_per_person. */
  duration?: TourDurationSource;
}

export function bookingTotal({ basePrice, priceUnit, participants, duration }: BookingTotalInput): number {
  const price = Number.isFinite(basePrice) && basePrice > 0 ? basePrice : 0;
  const people = Number.isFinite(participants) && participants > 0 ? Math.floor(participants) : 1;
  switch (normalizePriceUnit(priceUnit)) {
    case 'per_tour':
      return price;
    case 'per_day_per_person':
      return price * people * (duration ? tourDurationDays(duration) : 1);
    default:
      return price * people;
  }
}
