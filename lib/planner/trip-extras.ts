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
 *
 * Местный ночует дома (nightIsAtHome — то же правило, что у сметы): до
 * 09.10 смета ночь в Авачинской зоне ему не считала, а здесь на ту же ночь
 * подбиралось жильё — два ответа на один вопрос в соседних блоках экрана.
 *
 * ── Цена стоянки на группу (#2304, шаг 3) ────────────────────────────────
 *
 * Правило брони жилья: бронь берёт один номер и складывает цены его ночей
 * (app/api/accommodations/[id]/book), гостей в номере — не больше
 * max_guests. Группе, которой номер мал, нужно несколько номеров одного
 * типа. stayPriceForGroup выбирает самый дешёвый тип, куда группа
 * помещается целиком на все ночи. Разные типы вперемешку не подбираются:
 * это решает хозяин, и экран так и говорит, а не выдумывает раскладку.
 */

import { sleepZoneOf, type ZoneId } from '@/lib/planner/constants';
import { nightIsAtHome, type TripOrigin } from '@/lib/planner/trip-origin';
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
  origin: TripOrigin = 'visitor',
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
    if (nightIsAtHome(origin, zone)) { current = null; continue; }
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

/** Номер объекта на ночи стоянки — всё, что нужно для цены на группу. */
export interface RoomStayFacts {
  roomId: string;
  name: string;
  /** Гостей в одном номере (accommodation_rooms.max_guests). */
  maxGuests: number;
  /** Сколько таких номеров свободно на КАЖДУЮ ночь стоянки. */
  minFree: number;
  /** Цены ночей одного номера, сложенные — формула брони (roomNightsSql). */
  staySum: number;
}

export type StayPrice =
  | { kind: 'priced'; total: number; rooms: number; roomId: string; roomName: string; maxGuests: number }
  /** Ни в один тип номеров группа целиком не помещается — раскладку решает хозяин. */
  | { kind: 'no_fit'; people: number };

export function stayPriceForGroup(rooms: readonly RoomStayFacts[], people: number): StayPrice {
  let best: Extract<StayPrice, { kind: 'priced' }> | null = null;
  for (const r of rooms) {
    // Номер без вместимости или без цены посчитать нельзя — ноль не цена.
    if (!(r.maxGuests > 0) || !(r.staySum > 0)) continue;
    const need = Math.ceil(people / r.maxGuests);
    if (need > r.minFree) continue;
    const total = Math.round(need * r.staySum);
    if (!best || total < best.total || (total === best.total && need < best.rooms)) {
      best = { kind: 'priced', total, rooms: need, roomId: r.roomId, roomName: r.name, maxGuests: r.maxGuests };
    }
  }
  return best ?? { kind: 'no_fit', people };
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
