/**
 * lib/planner/estimate.ts — смета плана: одна формула для движка, экрана
 * /planner и Кузьмича (#2304).
 *
 * ── Почему отдельный модуль ────────────────────────────────────────────────
 *
 * До 09.10 смета жила внутри движка (`calculatePriceBreakdown` в
 * engine.ts), а движок тянет базу и модели. На экран она приходила один раз,
 * готовым числом: человек переставлял, удалял и добавлял дни, а «Оценка
 * стоимости» показывала цену плана, которого уже нет. Здесь только
 * арифметика по дням и профилю — без базы, без сети, — и тот же код
 * считает на сервере и в браузере после каждой правки.
 *
 * ── Что считается ─────────────────────────────────────────────────────────
 *
 * `calculatePriceBreakdown` — сумма цен туров на человека (её читают чат,
 * PDF и сторожа). До 14.11 это была вилка «Ориентир на человека» с жильём,
 * транспортом и днями без тура по средним ценам из кода.
 *
 * `estimateGroup` — смета на всю группу построчно (разбор конструктора
 * «Лагуны Экспедиции», #2304). Тур считается по своей единице цены:
 * за человека — на каждого, за группу — на каждую группу по вместимости
 * тура, за день на человека — на каждый день тура и каждого. До этого
 * туры с ценой не за человека из суммы выпадали, а умножения на состав не
 * было нигде.
 *
 * Сумма — только из цен с источником (слово владельца 14.11 «5 -1»): цена
 * тура оператора и цена выбранного предложения на платформе. До 14.11 дни
 * без тура, ночи по зоне, переезды и трансфер аэропорта входили в итог
 * «ориентиром» — вилками, зашитыми в код: ни одного из этих чисел не было в
 * данных. Теперь у таких строк суммы нет, и сказано, кто называет цену:
 * исполнитель занятия, хозяин жилья, перевозчик.
 *
 * Чего не знаем — строка без суммы, и в итог она не входит (§4.0): ноль
 * вместо неизвестной цены выдал бы смету за точную.
 *
 * Выбранное жильё (#2304, шаг 3; lib/planner/plan-choices) — пункт плана с
 * ценой предложения на платформе: ночи выбранной стоянки выходят из строки
 * проживания по зоне, а стоянка встаёт своей строкой. Трансфер — машина
 * целиком под заказ (13.10): цены до заявки перевозчику нет.
 *
 * Аудит планировщика 07.11, волна 2.5. Машина напрокат (E7): человек за
 * рулём, и трансфер аэропорта не считается, если его не отметили отдельно;
 * цены проката до заявки нет — строка допущений, а не сумма. Ночь дня
 * переезда — в зоне, куда приехали (E11, nightZoneOf).
 */
// Только чистые модули: смету считает браузер, а движок тянет базу и модели
// (сторож client-no-node-builtins идёт и по импортам типов).
import { nightZoneOf, type ZoneId, type BudgetTier, type DayType } from '@/lib/planner/constants';
import { asTripOrigin, nightIsAtHome, paysAirportTransfers, type TripOrigin } from '@/lib/planner/trip-origin';
import { bookingTotal } from '@/lib/tours/booking-total';
import { dateOfTripDay } from '@/lib/planner/flow-balance';
import type { PlanChoices } from '@/lib/planner/plan-choices';
import { nightLodgingIncluded } from '@/lib/planner/lodging-included';
import { freeDay } from '@/lib/planner/calendar-days';

// ── Входные данные ───────────────────────────────────────────────────────────

/**
 * День плана в том объёме, который нужен смете. День движка (`DayPlan`)
 * подходит как есть; экран /planner передаёт свои дни после правок.
 */
export interface EstimateDay {
  day: number;
  type: DayType;
  zone: ZoneId;
  title: string;
  priceFrom: number;
  priceTo: number;
  /** Цена тура за единицу по правилу брони — только у первого дня тура. */
  realPrice?: number;
  /** Цены тура для этой группы нет, и почему — только у первого дня тура. */
  priceMissing?: string;
  realTour?: {
    tourId: string;
    /** `per_person`, `per_tour` (за группу), `per_day_per_person`. */
    priceUnit?: string;
    /** Вместимость группы тура; 0 или нет — не указана. */
    maxParticipants?: number;
    /** Дни тура по правилу брони — для цены «за день на человека». */
    durationDays?: number;
    lodgingIncluded: boolean | null;
  };
}

export interface EstimateProfile {
  adults: number;
  /** Возрасты детей. */
  children: number[];
  budgetTier: BudgetTier;
  tripOrigin?: TripOrigin;
  /** Дата прилёта: по ней ночи плана сличаются с выбранным жильём. */
  arrivalDate?: string | null;
  /**
   * Что человек отметил в «Как хотите ехать» (аудит 07.11, E7). Машина
   * напрокат — он за рулём, и трансфер аэропорта смета не считает, если
   * трансфер он не отметил сам. Не записано — как раньше: трансфер считается.
   */
  needs?: { car?: boolean; transfer?: boolean };
}

// ── Строки без суммы ─────────────────────────────────────────────────────────

/**
 * Ни одной строки с суммой — итога нет, и «0 ₽» его бы выдумал. «Туры не
 * выбраны» здесь сказать нельзя: тур в плане может стоять без цены для этой
 * группы.
 */
export const NO_PRICES_YET =
  'Цен в плане пока нет: их называют операторы, хозяева жилья и перевозчики.';

/**
 * Кто называет цену строки без суммы — по её роду. Чисел здесь нет
 * намеренно (слово владельца 14.11 «5 -1»): до 14.11 на этом месте стояли
 * ночь по зоне «эконом / комфорт / премиум» и трансфер аэропорта
 * 2 500–5 000 ₽ на человека — ни одного из них не было в данных.
 */
export const OPEN_PRICE_WORDS = {
  activity: 'тур не выбран — цену называет исполнитель',
  lodging: 'цену называет хозяин жилья',
  transport: 'цену называет перевозчик',
} as const;

/**
 * Считать ли трансфер аэропорта: только у прилетающего и не у того, кто сам
 * за рулём (аудит 07.11, E7) — если трансфер он не отметил отдельно. До этого
 * трансфер прибавлялся всем прилетающим, даже с машиной напрокат.
 */
function countsAirportTransfer(origin: TripOrigin, needs: EstimateProfile['needs']): boolean {
  if (!paysAirportTransfers(origin)) return false;
  return !(needs?.car === true && needs.transfer !== true);
}

/*
 * Множителей сметы нет (решение владельца 11.11, #3199, E12), и вилок по
 * средним ценам тоже нет (14.11): цену тура называет оператор, цену
 * выбранного жилья — его предложение на платформе, остальное — исполнитель.
 */

/**
 * Дни, на которых может стоять тур оператора: его цена входит в итог.
 * Переезд — отдельной строкой транспорта.
 */
export function countsAsActivityCost(type: DayType): boolean {
  return type === 'activity' || type === 'buffer' || type === 'arrival' || type === 'rest' || type === 'departure';
}

/** Дни занятий: без тура на них цену называет исполнитель (строка без суммы). */
function isActivityDay(type: DayType): boolean {
  return type === 'activity' || type === 'buffer';
}

const ZONE_GENITIVE: Record<ZoneId, string> = {
  avachinsky: 'Авачинской зоне',
  western: 'Западной зоне',
  eastern: 'Восточной зоне',
  northern: 'Северной зоне',
  southern: 'Южной зоне (у Курильского озера)',
};

/**
 * Ночь этого дня: в какой зоне её проводят; null — ночи, оплачиваемой
 * отдельно, нет. `next` — следующий день плана: ночь дня переезда — в зоне,
 * куда приехали.
 */
function nightOf(
  day: EstimateDay, next: EstimateDay | undefined, lastDayNum: number, origin: TripOrigin,
): { zone: ZoneId } | null {
  if (day.type === 'departure' || day.day === lastDayNum) return null;
  // Ночь после последнего дня тура тур не покрывает (Б32).
  if (nightLodgingIncluded(day, next) === true) return null;
  // В зоне не ночуют — ночь считается там, где ночуют на самом деле; ночь
  // переезда — там, куда приехали (nightZoneOf, аудит 07.11, E11).
  const sleepZone = nightZoneOf(day, next);
  if (nightIsAtHome(origin, sleepZone)) return null;
  return { zone: sleepZone };
}

// ── Цены туров на человека ───────────────────────────────────────────────────

export interface PriceBreakdown {
  /**
   * Сумма цен туров операторов на человека — только туры с ценой за человека.
   * Ночи, переезды, трансфер и дни без тура сюда не входят: их цену называет
   * исполнитель (слово владельца 14.11 «5 -1»).
   */
  tours: [number, number];
  /**
   * Из чего сложено (#2223): сколько дней по цене тура оператора, сколько
   * дней занятий без тура (цену называет исполнитель), сколько туров в сумму
   * НЕ вошли, потому что их цена не за человека, и сколько без цены для этой
   * группы.
   */
  activityPricing: {
    tourPriced: number;
    /** Дни занятий без тура: цену называет исполнитель. */
    open: number;
    excluded: number;
    /**
     * Туры без цены для этой группы (#2304): группа вне ступеней цены
     * оператора или цену не удалось проверить. В сумму не идут.
     */
    unpriced: number;
  };
}

/**
 * Дни плана подряд: незаполненный день внутри поездки — свободный день там
 * же, где человек был накануне (разбор планера 14.11, смета-1).
 *
 * Движок недобор не набивает («остальные дни не придумываем»), и номера дней
 * идут с пропусками: 1 прилёт, 2–3 занятия, 7 вылет. Ночь при этом проходит
 * каждая — человек где-то ночует и 4-го, и 5-го. Смета считала ночи по
 * записанным дням и давала три ночи вместо шести там, где дни не достроил
 * экран (Кузьмич, MCP, план из черновика, правка плана). Экран /planner
 * достраивал их сам (`fillCalendarGaps`) — теперь смета считает одинаково на
 * всех поверхностях. Порядок дней сбит (повтор номера) — дни как есть: номер
 * по месту здесь не назначается, к нему привязан выбор жилья.
 */
export function withFreeDays<T extends EstimateDay>(days: readonly T[]): Array<T | EstimateDay> {
  const out: Array<T | EstimateDay> = [];
  for (const d of days) {
    const prev = out[out.length - 1];
    if (prev && d.day <= prev.day) return [...days];
    if (prev) for (let n = prev.day + 1; n < d.day; n++) out.push(freeDay(n, prev));
    out.push(d);
  }
  return out;
}

export function calculatePriceBreakdown(planDays: EstimateDay[]): PriceBreakdown {
  // Пропуски в номерах дней — свободные дни (разбор планера 14.11, смета-1).
  const days = withFreeDays(planDays);
  // Цена тура оператора — только если она за человека: цену группы или дня
  // сложить как цену человека значило бы соврать в итоге (#2223); такой тур
  // в сумму не идёт и называется отдельно. Продолжение многодневного тура
  // (цена учтена в первом дне) не считается. Плана нет — суммы нет.
  let from = 0;
  let to = 0;
  const activityPricing = { tourPriced: 0, open: 0, excluded: 0, unpriced: 0 };
  for (const d of days) {
    if (!countsAsActivityCost(d.type)) continue;
    // Цены тура для группы нет — в сумму не идёт.
    if (d.priceMissing) { activityPricing.unpriced++; continue; }
    if (d.realPrice) {
      // Без записи о туре единица цены неизвестна — не «за человека» (смета-6).
      if (d.realTour?.priceUnit !== 'per_person') { activityPricing.excluded++; continue; }
      from += d.realPrice;
      to += d.realPrice;
      activityPricing.tourPriced++;
      continue;
    }
    if (d.realTour) continue;
    if (isActivityDay(d.type)) activityPricing.open++;
  }
  return { tours: [from, to], activityPricing };
}

// ── Смета на группу ──────────────────────────────────────────────────────────

export interface EstimateLine {
  kind: 'tour' | 'activity' | 'lodging' | 'transport';
  /** Что это: «Тур „Вулкан“, день 3», «Проживание в Авачинской зоне». */
  label: string;
  /** Как получена сумма: «12 000 ₽ × 3 чел.», «45 000 ₽ за группу × 2». */
  basis: string;
  /** Сумма строки на всю группу; null — цену не знаем, в итог не входит. */
  total: [number, number] | null;
  /**
   * Цена оператора тура, цена выбранного предложения на платформе (жильё)
   * или `open` — цены в данных нет, её называет исполнитель; у такой строки
   * суммы нет никогда (слово владельца 14.11 «5 -1»).
   */
  source: 'tour' | 'offer' | 'open';
  /** Пояснение, если в строке есть допущение. */
  note?: string;
}

export interface GroupEstimate {
  /** Сколько человек в смете: взрослые и дети. */
  people: number;
  lines: EstimateLine[];
  /** Сумма строк с ценой. */
  total: [number, number];
  /** Итог, делённый на состав, — для сравнения с ценами туров на человека. */
  perPerson: [number, number];
  /** Подписи строк без цены: в итог не вошли. */
  unpriced: string[];
  /** Сколько итога — цены туров операторов и цены выбранных предложений. */
  fromTours: [number, number];
  fromOffers: [number, number];
  /** Допущения сметы словами: показываются рядом с итогом. */
  assumptions: string[];
}

/**
 * Кто назовёт цену строк сметы без суммы — по их роду. Одно правило для
 * экрана /planner и ответа Кузьмича (аудит планировщика 07.11, волна 2.5):
 * тур — карточка тура, занятие без тура — исполнитель, жильё — хозяин,
 * переезд и трансфер — перевозчик.
 */
/**
 * «Посчитано X из Y позиций» (кейс владельца 21.11: итог 170 000 ₽ при шести
 * строках «цены нет» читался как цена поездки). Одна строка для экрана,
 * печати и Кузьмича.
 */
export function countedLine(lines: readonly Pick<EstimateLine, 'total'>[]): string {
  const priced = lines.filter((l) => l.total).length;
  return `Посчитано ${priced} из ${lines.length} позиций`;
}

export function unpricedTail(lines: readonly EstimateLine[]): string {
  const open = lines.filter((l) => !l.total);
  const parts: string[] = [];
  if (open.some((l) => l.kind === 'tour')) parts.push('сумму тура смотрите в его карточке');
  if (open.some((l) => l.kind === 'activity')) parts.push('цену занятий без тура назовёт исполнитель');
  if (open.some((l) => l.kind === 'lodging')) parts.push('цену жилья назовёт хозяин');
  if (open.some((l) => l.kind === 'transport')) parts.push('цену переездов и трансфера назовёт перевозчик');
  return `${parts.join(', ')}.`;
}

const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU');
const peopleWord = (n: number) => `${n} чел.`;
const dayWord = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'день' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'дня' : 'дней');
const nightWord = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'ночь' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'ночи' : 'ночей');

const roomWord = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'номер' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'номера' : 'номеров');
const ddmm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

/**
 * Дни одной постановки тура в плане: первый день и идущие за ним дни
 * продолжения того же тура. Не все дни плана с этим туром: тур может стоять в
 * плане дважды, и тогда «за день» посчиталось бы за обе постановки дважды.
 */
function runLength(day: EstimateDay, days: EstimateDay[]): number {
  const at = days.indexOf(day);
  let n = 1;
  for (let i = at + 1; i < days.length; i++) {
    const d = days[i]!;
    if (d.realTour?.tourId !== day.realTour?.tourId || d.realPrice || d.priceMissing) break;
    n++;
  }
  return n;
}

/**
 * Сумма тура на группу по правилу брони (`bookingTotal`) — одна на смету плана
 * и на compose_trip (#2304, шаг 1в): за человека — на каждого, за группу —
 * одна сумма, за день — на каждого и каждый день тура. Сверх брони знает одно:
 * группа больше вместимости тура «за группу» едет несколькими группами.
 * null — единица цены не распознана: сумму не выдумываем.
 */
export function tourGroupCost(a: {
  unitPrice: number;
  priceUnit: string | null | undefined;
  people: number;
  maxParticipants?: number;
  tourDays?: number;
}): { total: number; groups: number } | null {
  const unit = a.priceUnit;
  if (unit !== 'per_person' && unit !== 'per_tour' && unit !== 'per_day_per_person') return null;
  const days = unit === 'per_day_per_person' ? Math.max(1, a.tourDays ?? 1) : 1;
  const cap = a.maxParticipants ?? 0;
  const groups = unit === 'per_tour' && cap > 0 ? Math.ceil(a.people / cap) : 1;
  const one = bookingTotal({
    basePrice: a.unitPrice, priceUnit: unit, participants: a.people,
    duration: { multi_day_count: days, duration_hours: null },
  });
  return { total: one * groups, groups };
}

/**
 * Строка тура по его единице цены.
 *
 * Сумма одной брони — правилом самой брони (`bookingTotal`): за человека — на
 * каждого, за группу — одна сумма, за день — на каждого и каждый день тура.
 * Цена за единицу уже посчитана движком по ступеням и правилам на дату
 * (lib/planner/tour-price). Сверх брони смета знает одно: группа больше
 * вместимости тура «за группу» едет двумя группами.
 */
function tourLine(day: EstimateDay, days: EstimateDay[], people: number): EstimateLine {
  const price = day.realPrice!;
  // Без записи о туре неизвестно, за что цена: ни здесь, ни в сумме на
  // человека (`calculatePriceBreakdown`) она не считается «за человека» —
  // так же её подписывает карточка дня (day-price: «за что — не записано»).
  // Разбор 14.11, смета-6: карточка писала «за что — не записано», а смета
  // умножала на всю группу. Движок так дни не собирает — это сохранённые и
  // правленые поездки (схема trip-schema такой день допускает).
  const unit = day.realTour?.priceUnit ?? '';
  const label = `Тур «${day.title}», день ${day.day}`;
  if (unit !== 'per_person' && unit !== 'per_tour' && unit !== 'per_day_per_person') {
    // Незнакомую единицу смета не толкует как «за человека»: так же молчит о
    // ней и витрина (lib/tours/price-label, priceWithUnitWords).
    return {
      kind: 'tour', label, basis: `${fmt(price)} ₽`, total: null, source: 'tour',
      note: unit ? `Единица цены «${unit}» не распознана — сумму смотрите в карточке тура.` : 'Не указано, за что цена тура, — сумму смотрите в карточке тура.',
    };
  }

  const tourDays = unit === 'per_day_per_person' ? (day.realTour?.durationDays ?? runLength(day, days)) : 1;
  const cap = day.realTour?.maxParticipants ?? 0;
  const cost = (p: number) => tourGroupCost({ unitPrice: p, priceUnit: unit, people, maxParticipants: cap, tourDays })!;
  const groups = cost(price).groups;
  const total: [number, number] = [cost(price).total, cost(price).total];

  if (unit === 'per_person') {
    return { kind: 'tour', label, basis: `${fmt(price)} ₽ × ${peopleWord(people)}`, total, source: 'tour' };
  }
  if (unit === 'per_tour') {
    return {
      kind: 'tour', label,
      basis: `${fmt(price)} ₽ за группу${groups > 1 ? ` × ${groups} (до ${cap} чел. в группе)` : ''}`,
      total, source: 'tour',
      ...(cap > 0 ? {} : { note: 'Вместимость группы у тура не указана — посчитана одна группа.' }),
    };
  }
  return {
    kind: 'tour', label,
    basis: `${fmt(price)} ₽ × ${tourDays} ${dayWord(tourDays)} × ${peopleWord(people)}`,
    total, source: 'tour',
  };
}

/** «1 ночи», «2 ночей», «5 ночей» — после «нет». */
function nightGenitive(n: number): string {
  return n % 10 === 1 && n % 100 !== 11 ? 'ночи' : 'ночей';
}

/**
 * Смета плана на группу построчно.
 *
 * Состав — взрослые и дети; дети считаются по цене взрослого: скидок
 * платформа не знает, и смета так и говорит (строка «Дети» не заводится —
 * это допущение, а не цена).
 */
export function estimateGroup(planDays: EstimateDay[], profile: EstimateProfile, choices?: PlanChoices): GroupEstimate {
  const days = withFreeDays(planDays);
  const people = Math.max(1, profile.adults + profile.children.length);
  const origin = asTripOrigin(profile.tripOrigin);
  const lines: EstimateLine[] = [];

  // Активности: туры по своей единице цены; день занятий без тура — строка
  // без суммы, цену называет исполнитель. Дни прилёта, отдыха и отъезда без
  // тура строки не дают: покупать на них нечего.
  for (const d of days) {
    if (!countsAsActivityCost(d.type)) continue;
    // Цены тура для этой группы нет: строка есть, в итог не входит (§4.0).
    if (d.priceMissing) {
      lines.push({
        kind: 'tour', label: `Тур «${d.title}», день ${d.day}`, basis: 'цену называет оператор',
        total: null, source: 'tour', note: d.priceMissing,
      });
      continue;
    }
    if (d.realPrice) {
      lines.push(tourLine(d, days, people));
      continue;
    }
    // Продолжение многодневного тура: цена учтена в первом дне.
    if (d.realTour) continue;
    if (!isActivityDay(d.type)) continue;
    lines.push({
      kind: 'activity', label: `«${d.title}», день ${d.day}`,
      basis: OPEN_PRICE_WORDS.activity, total: null, source: 'open',
    });
  }

  // Ночь, на которую выбрано жильё: строка проживания по зоне её больше не
  // считает. Без даты прилёта ночи плана с датами стоянки не сличить — выбранное жильё тогда
  // не ставится вовсе, иначе ночь посчиталась бы дважды.
  const stays = profile.arrivalDate ? choices?.stays ?? [] : [];
  const chosenNight = (zone: ZoneId, dayNum: number): boolean => {
    const date = profile.arrivalDate ? dateOfTripDay(profile.arrivalDate, dayNum) : null;
    return date !== null && stays.some((s) => s.zone === zone && s.checkIn <= date && date < s.checkOut);
  };

  // Ночи — по зоне, где ночуют, одной строкой на зону; суммы у строки нет.
  let nightsInToursTotal = 0;
  if (days.length > 1) {
    const lastDayNum = days[days.length - 1]!.day;
    const byZone = new Map<ZoneId, { nights: number }>();
    // Ночи, которые в строки проживания не вошли, потому что входят в тур
    // (#3347): «проживание 5 ночей» при шести ночах поездки стояло без
    // объяснения — пояснение было в данных, а экран его прятал.
    let nightsInTours = 0;
    for (const [i, day] of days.entries()) {
      if (day.type !== 'departure' && day.day !== lastDayNum && nightLodgingIncluded(day, days[i + 1]) === true) nightsInTours++;
      const night = nightOf(day, days[i + 1], lastDayNum, origin);
      if (!night || chosenNight(night.zone, day.day)) continue;
      const z = byZone.get(night.zone) ?? { nights: 0 };
      z.nights++;
      byZone.set(night.zone, z);
    }
    for (const [zone, z] of byZone) {
      lines.push({
        kind: 'lodging', label: `Проживание в ${ZONE_GENITIVE[zone]}`,
        basis: `${z.nights} ${nightWord(z.nights)} — ${OPEN_PRICE_WORDS.lodging}`,
        total: null, source: 'open',
      });
    }
    nightsInToursTotal = nightsInTours;
  }

  // Выбранное жильё — по цене предложения: правило брони, номера × ночи.
  for (const st of stays) {
    const label = `Жильё «${st.name}», ${ddmm(st.checkIn)}–${ddmm(st.checkOut)}`;
    if (st.price?.kind === 'priced') {
      const { total, rooms, roomName } = st.price;
      lines.push({
        kind: 'lodging', label,
        basis: `${st.nights} ${nightWord(st.nights)} × ${rooms} ${roomWord(rooms)} «${roomName}»`,
        total: [total, total], source: 'offer',
      });
    } else {
      lines.push({
        kind: 'lodging', label, basis: `${st.nights} ${nightWord(st.nights)}`, total: null, source: 'offer',
        note: st.price
          ? `Группа из ${st.price.people} чел. в один тип номеров не помещается — номера и цену подберёт хозяин.`
          : 'Цену стоянки на группу не посчитали — она в карточке объекта.',
      });
    }
  }

  // Переезды и трансферы аэропорта: цены в данных нет — строка без суммы
  // (§4.0): до аудита 07.11 переезд без цены молча выпадал из сметы, как
  // бесплатный.
  for (const d of days) {
    if (d.type !== 'travel') continue;
    lines.push({
      kind: 'transport', label: `${d.title}, день ${d.day}`, basis: OPEN_PRICE_WORDS.transport,
      total: null, source: 'open',
    });
  }
  // На дорогу туда и обратно; за рулём своей машины — не нужен.
  if (countsAirportTransfer(origin, profile.needs) && days.length > 0) {
    lines.push({
      kind: 'transport', label: 'Трансферы аэропорта', basis: OPEN_PRICE_WORDS.transport,
      total: null, source: 'open',
    });
  }

  const sum = (pick: (l: EstimateLine) => boolean): [number, number] =>
    lines.filter((l) => l.total && pick(l)).reduce<[number, number]>(
      (acc, l) => [acc[0] + l.total![0], acc[1] + l.total![1]], [0, 0]);
  const total = sum(() => true);

  const assumptions: string[] = [];
  // Ночи, включённые в туры, — фактом и числом (#3347): «проживание 5 ночей»
  // при шести ночах поездки читалось как ошибка счёта.
  if (nightsInToursTotal > 0) {
    assumptions.push(`В строках проживания нет ${nightsInToursTotal} ${nightGenitive(nightsInToursTotal)}: `
      + `${nightsInToursTotal === 1 ? 'она входит' : 'они входят'} в цену тура.`);
  }
  if (profile.children.length > 0) {
    assumptions.push('Дети посчитаны по цене взрослого: скидок платформа не знает — уточняйте у оператора.');
  }
  // Машина напрокат (E7): цены до заявки прокатчику нет — строкой словами,
  // а не суммой; трансфер аэропорта при ней не считается, если его не просили.
  if (profile.needs?.car === true) {
    assumptions.push(paysAirportTransfers(origin) && !countsAirportTransfer(origin, profile.needs)
      ? 'Трансфер аэропорта не посчитан: в плане машина напрокат. Прокат в смету не входит — цену подтверждает прокатчик.'
      : 'Машина напрокат в смету не входит — цену подтверждает прокатчик.');
  }

  return {
    people,
    lines,
    total,
    perPerson: [Math.round(total[0] / people), Math.round(total[1] / people)],
    unpriced: lines.filter((l) => !l.total).map((l) => l.label),
    fromTours: sum((l) => l.source === 'tour'),
    fromOffers: sum((l) => l.source === 'offer'),
    assumptions,
  };
}
