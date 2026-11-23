/**
 * Что ещё нужно к поездке: жильё, трансфер, машина (решение владельца 26.09).
 *
 * Чистая часть — без базы: из дней плана выводит, где и в какие ночи нужно
 * жильё, окно дат для трансферов и честный ответ про аренду машин. Запросы
 * к базе — lib/planner/trip-extras-data.ts, роут — /api/planner/trip-extras.
 *
 * ── Настоящее против оценки (§4.0) ───────────────────────────────────────
 *
 * До 14.11 у движка были «Размещение» и «Транспорт» в priceBreakdown — ОЦЕНКА
 * из констант, а не предложения; с 14.11 их нет (слово владельца «5 -1»):
 * в смете ночь и трансфер стоят строками без суммы. Здесь — только то, что
 * лежит на платформе: объекты с витрины и опубликованные поездки
 * перевозчиков.
 *
 * ── Ночи ──────────────────────────────────────────────────────────────────
 *
 * Ночь дня N — дата прилёта + (N−1). Ночуют все дни, кроме дня отъезда.
 * Зона ночи — nightZoneOf: северная зона однодневная, ночь в Авачинской, а
 * ночь дня переезда — в зоне, куда приехали (то же правило, что у сметы,
 * аудит 07.11, E11). Ночь, которую тур ПОКРЫВАЕТ (`lodgingIncluded === true`;
 * вызывающий считает флаг nightLodgingIncluded — у последнего дня тура он
 * false, #3199, Б32), жилья не требует — она
 * разрывает стоянку и считается отдельно. `null` («не разобрали состав»)
 * считается как «нужно жильё»: лишний вариант дешевле ночи без крыши.
 * Соседние ночи одной зоны сливаются в одну стоянку — её и бронируют.
 *
 * Ночи в Авачинской зоне у того, кто выбрал «Живу на Камчатке», в смете не
 * стоят (nightIsAtHome). В списке жилья они есть: PDF 23.11 оставлял дни
 * 6–11 без варианта ночёвки. Выбрал вариант — он в сумму не входит, пока
 * выбран пункт «живу здесь»; приезжий («Прилетаю») получает те же ночи и в
 * списке, и в смете.
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

import { nightZoneOf, type ZoneId } from '@/lib/planner/constants';
import type { TripOrigin } from '@/lib/planner/trip-origin';
import { dateOfTripDay } from '@/lib/planner/flow-balance';

export const TRIP_NEEDS = ['lodging', 'transfer', 'car'] as const;
export type TripNeed = (typeof TRIP_NEEDS)[number];
export type TripNeeds = Partial<Record<TripNeed, boolean>>;

/** Сколько вариантов жилья показывать на одну стоянку. */
export const LODGING_OPTIONS_PER_STAY = 3;

/**
 * Порядок жилья в подборе к плану (#3394 п.1, карт-бланш владельца 16.11).
 *
 *  - `default` — как было: проверенные Ведаром, затем оценка гостей и цена
 *    за ночь;
 *  - `cheapest` — уровень «эконом»: сначала дешевле на группу за все ночи.
 *
 * Классов жилья в базе нет, поэтому «эконом» значит только порядок по цене:
 * объект «эконом-жильём» не называется, его цена стоит рядом. Порядок
 * говорится человеку словами (§0): `LODGING_ORDER_NOTE_RU`.
 */
export type LodgingOrder = 'default' | 'cheapest';

export function lodgingOrderFor(tier: 'economy' | 'comfort' | 'premium' | null | undefined): LodgingOrder {
  return tier === 'economy' ? 'cheapest' : 'default';
}

/** Порядок списка словами — экран планера (там только номера по календарю). */
export const LODGING_ORDER_NOTE_RU: Record<LodgingOrder, string> = {
  default: 'Порядок: сначала проверенные Ведаром, затем по оценке гостей и цене за ночь. Место в списке не продаётся.',
  cheapest: 'Порядок по уровню «эконом»: сначала дешевле на вашу группу за все ночи; где цену на группу не посчитать — после, по цене за ночь. Место в списке не продаётся.',
};

/** Порядок словами для ответа Кузьмича и ИИ-агента: там и жильё по заявке хозяину. */
export const PLAN_LODGING_ORDER_NOTE_RU: Record<LodgingOrder, string> = {
  default: 'Порядок жилья: сначала номера по календарю — проверенные Ведаром, затем по оценке гостей и цене за ночь; затем жильё по заявке хозяину — проверенные, затем по цене за ночь. Место в списке не продаётся.',
  cheapest: 'Порядок жилья по уровню «эконом»: сначала номера по календарю — дешевле на группу за все ночи (где цену на группу не посчитать — после, по цене за ночь); затем жильё по заявке хозяину — по цене за ночь. Место в списке не продаётся.',
};

/**
 * Дешевле на группу — раньше. Цена на группу считается тем же правилом, что
 * бронь (stayPriceForGroup); где группа не помещается или цены нет — после,
 * по цене за ночь «от»; цены нет вовсе — в конце. Ничья — по имени, чтобы
 * порядок не зависел от того, как база отдала строки.
 */
export function cheapestFirst<T extends { name: string; priceFrom: number | null; stay: StayPrice }>(items: readonly T[]): T[] {
  const groupTotal = (x: T) => (x.stay.kind === 'priced' ? x.stay.total : null);
  const cmpNullLast = (a: number | null, b: number | null) =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : a - b;
  return [...items].sort((a, b) =>
    cmpNullLast(groupTotal(a), groupTotal(b))
    || cmpNullLast(a.priceFrom, b.priceFrom)
    || a.name.localeCompare(b.name, 'ru'));
}

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
  for (const [i, d] of sorted.entries()) {
    if (d.type === 'departure') { current = null; continue; }
    const night = dateOfTripDay(arrivalDate, d.day);
    if (!night) { current = null; continue; }
    // Ночь в день вылета или позже — не ночь этой поездки.
    if (departureDate && night >= departureDate) { current = null; continue; }
    if (d.lodgingIncluded === true) { nightsInTours++; current = null; continue; }

    // Ночь дня переезда — в зоне, куда приехали (nightZoneOf, E11).
    // Ночь дома тоже в списке. Смета сама её не ставит; выбранный вариант
    // считает отдельно, и текст у сметы так и говорит.
    const zone = nightZoneOf(d, sorted[i + 1]);
    void origin;
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

/** Размер группы: взрослые и дети — каждому место (жильё на группу). */
export function groupSeats(adults: number, children: readonly number[]): number {
  return Math.max(1, adults) + children.length;
}

/**
 * Машина напрокат — три исхода (§4.0), как у жилья и трансфера. С 23.10
 * (решение владельца «пока берем аренду автомобилей и трансфер», схема 1317)
 * прокатчики с прайсом на платформе есть, и их ищет findCarRentalOffers
 * (lib/planner/trip-extras-data). Здесь — два ответа без данных:
 *   · никого с прайсом нет — прежнее честное «пока нет» (решение владельца
 *     26.09: без выдуманных прокатчиков и без ссылок наружу);
 *   · не смогли проверить — «не смог» не выдаётся за «нет».
 */
export const CAR_RENTAL_ANSWER = {
  state: 'not_offered' as const,
  message: 'Аренды автомобилей на платформе пока нет',
  hint: 'Доехать можно трансфером перевозчика или выбрать тур, где транспорт уже включён.',
};

/**
 * Прокатчики есть, но сайт их сейчас не показывает — пауза владельца 23.10
 * (lib/rental/site-pause). Не «проката нет»: называется, когда вернётся.
 */
export function carRentalPausedAnswer(returnsOn: string) {
  return {
    state: 'not_offered' as const,
    message: `Прокат автомобилей вернётся на сайт ${returnsOn}`,
    hint: CAR_RENTAL_ANSWER.hint,
  };
}

export const CAR_RENTAL_UNAVAILABLE = {
  state: 'unavailable' as const,
  message: 'Не смогли проверить прокат автомобилей',
};
