/**
 * Что ещё нужно к поездке: жильё, трансфер, машина (решение владельца 26.09).
 *
 * Чистая часть — без базы: из дней плана выводит, где и в какие ночи нужно
 * жильё, окно дат для трансферов и честный ответ про аренду машин. Запросы
 * к базе — lib/planner/trip-extras-data.ts, роут — /api/planner/trip-extras.
 *
 * ── Настоящее против оценки (§4.0) ───────────────────────────────────────
 *
 * У движка уже есть «Размещение» и «Транспорт» в priceBreakdown — это ОЦЕНКА
 * из констант (ZONE_ACCOMMODATION, +2500..5000 ₽ за трансфер), а не
 * предложения. Здесь — только то, что лежит на платформе: объекты с витрины
 * и опубликованные поездки перевозчиков. Экран держит их раздельно и
 * подписывает оценку оценкой, чтобы одно не читалось как другое.
 *
 * ── Ночи ──────────────────────────────────────────────────────────────────
 *
 * Ночь дня N — дата прилёта + (N−1). Ночуют все дни, кроме дня отъезда.
 * Зона ночи — sleepZoneOf(day.zone): северная зона однодневная, ночь в
 * Авачинской (то же правило, что у оценки движка). Ночь дня, чей тур
 * ВКЛЮЧАЕТ проживание (`lodgingIncluded === true`), жилья не требует — она
 * разрывает стоянку и считается отдельно. `null` («не разобрали состав»)
 * считается как «нужно жильё»: лишний вариант дешевле ночи без крыши.
 * Соседние ночи одной зоны сливаются в одну стоянку — её и бронируют.
 */

import { sleepZoneOf, type ZoneId } from '@/lib/planner/constants';
import { dateOfTripDay } from '@/lib/planner/flow-balance';

export const TRIP_NEEDS = ['lodging', 'transfer', 'car'] as const;
export type TripNeed = (typeof TRIP_NEEDS)[number];
export type TripNeeds = Partial<Record<TripNeed, boolean>>;

/** Сколько вариантов жилья показывать на одну стоянку. */
export const LODGING_OPTIONS_PER_STAY = 3;

/** Минимум, который нужен от дня плана, чтобы посчитать ночи. */
export interface ExtrasDay {
  day: number;
  type: 'arrival' | 'activity' | 'travel' | 'rest' | 'buffer' | 'departure';
  zone: ZoneId;
  /** Тур дня включает проживание: true / false / null — не знаем. */
  lodgingIncluded?: boolean | null;
}

/** Стоянка: подряд идущие ночи в одной зоне. checkOut — дата выезда. */
export interface LodgingStay {
  zone: ZoneId;
  checkIn: string;
  checkOut: string;
  nights: number;
}

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Стоянки по дням плана. Без даты прилёта ночей не посчитать — пустой
 * результат, и вызывающий обязан сказать «укажите даты», а не «жилья нет».
 */
export function lodgingStays(
  days: readonly ExtrasDay[],
  arrivalDate: string,
  departureDate?: string,
): { stays: LodgingStay[]; nightsInTours: number } {
  const stays: LodgingStay[] = [];
  let nightsInTours = 0;
  let current: LodgingStay | null = null;

  const sorted = [...days].sort((a, b) => a.day - b.day);
  for (const d of sorted) {
    if (d.type === 'departure') { current = null; continue; }
    const night = dateOfTripDay(arrivalDate, d.day);
    if (!night) { current = null; continue; }
    // Ночь в день вылета или позже — не ночь этой поездки.
    if (departureDate && night >= departureDate) { current = null; continue; }
    if (d.lodgingIncluded === true) { nightsInTours++; current = null; continue; }

    const zone = sleepZoneOf(d.zone);
    if (current && current.zone === zone && current.checkOut === night) {
      current.checkOut = addDays(night, 1);
      current.nights++;
    } else {
      current = { zone, checkIn: night, checkOut: addDays(night, 1), nights: 1 };
      stays.push(current);
    }
  }
  return { stays, nightsInTours };
}

/** Размер группы для мест в трансфере: взрослые и дети — каждому место. */
export function groupSeats(adults: number, children: readonly number[]): number {
  return Math.max(1, adults) + children.length;
}

/**
 * Машины напрокат на платформе нет (решение владельца 26.09: честное «пока
 * нет», без выдуманных прокатчиков и без ссылок наружу).
 */
export const CAR_RENTAL_ANSWER = {
  state: 'not_offered' as const,
  message: 'Аренды автомобилей на платформе пока нет',
  hint: 'Доехать можно трансфером перевозчика или выбрать тур, где транспорт уже включён.',
};
