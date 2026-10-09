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
 * `calculatePriceBreakdown` — прежняя вилка на человека, перенесена без
 * изменений (её читают чат, PDF и сторожа).
 *
 * `estimateGroup` — смета на всю группу построчно (разбор конструктора
 * «Лагуны Экспедиции», #2304). Тур считается по своей единице цены:
 * за человека — на каждого, за группу — на каждую группу по вместимости
 * тура, за день на человека — на каждый день тура и каждого. До этого
 * туры с ценой не за человека из суммы выпадали, а умножения на состав не
 * было нигде.
 *
 * Ориентиры — дни без тура, ночи, переезды — остаются в прежнем смысле
 * «на человека» и умножаются на состав. Чего они не значат, здесь не
 * выдумывается: если ночь на деле считается за номер, а не за человека,
 * смета это не угадывает, а называет ориентиром.
 *
 * Чего не знаем — строка «цена не указана», и в итог она не входит (§4.0):
 * ноль вместо неизвестной цены выдал бы смету за точную.
 */
// Только чистые модули: смету считает браузер, а движок тянет базу и модели
// (сторож client-no-node-builtins идёт и по импортам типов).
import { ZONE_SLEEPS_IN, sleepZoneOf, type ZoneId, type BudgetTier, type DayType } from '@/lib/planner/constants';
import { asTripOrigin, nightIsAtHome, paysAirportTransfers, type TripOrigin } from '@/lib/planner/trip-origin';
import { bookingTotal } from '@/lib/tours/booking-total';

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
}

// ── Ориентиры ────────────────────────────────────────────────────────────────

interface AccommodationInfo {
  types: string[];
  pricePerNight: [number, number, number]; // [economy, comfort, premium]
  note: string;
  /**
   * Где турист НОЧУЕТ, если в этой зоне не ночуют.
   *
   * Заведено 20.09. У северной зоны стояло `pricePerNight: [0, 0, 0]` с
   * припиской «Однодневная экскурсия, ночёвка в Авачинской зоне» — то есть
   * факт был записан прозой, а код читал из него только ноль. Ночь,
   * которую человек проводит в Петропавловске, не считалась НИГДЕ: смета
   * занижалась ровно на неё.
   *
   * Тот же род дефекта, что двойной счёт ночи на базе, только в другую
   * сторону — и оба от того, что о ночёвке судили не по данным.
   */
  sleepsIn?: ZoneId;
}

const ZONE_ACCOMMODATION: Record<ZoneId, AccommodationInfo> = {
  avachinsky: {
    types: ['гостиница', 'апартаменты', 'хостел'],
    pricePerNight: [3000, 7000, 15000],
    note: 'Петропавловск / Паратунка — широкий выбор',
  },
  western: {
    types: ['рыболовная база', 'палатка'],
    pricePerNight: [8000, 20000, 40000],
    note: 'Удалённые базы, питание включено',
  },
  eastern: {
    types: ['эко-лодж', 'палатка', 'модуль'],
    pricePerNight: [10000, 25000, 50000],
    note: 'Ограниченное размещение, бронь заранее',
  },
  northern: {
    types: [],
    pricePerNight: [0, 0, 0],
    note: 'Однодневная экскурсия, ночёвка в Авачинской зоне',
    // Приписка выше теперь не только для чтения: ночь считается по той
    // зоне, где её реально проводят.
    sleepsIn: ZONE_SLEEPS_IN.northern,
  },
};

/** Трансферы аэропорта, ориентир на человека (только у прилетающего). */
const AIRPORT_TRANSFER: [number, number] = [2500, 5000];

/**
 * Верх вилки тура: цена оператора может вырасти (сезон, доплаты). Один
 * множитель на карточку дня и на смету: до 09.10 день показывал ×1.3, а
 * смета считала ×1.2, и сумма карточек не сходилась с итогом.
 */
export const TOUR_PRICE_HEADROOM = 1.2;

function budgetIndex(tier: BudgetTier): 0 | 1 | 2 {
  return tier === 'economy' ? 0 : tier === 'comfort' ? 1 : 2;
}

const ZONE_GENITIVE: Record<ZoneId, string> = {
  avachinsky: 'Авачинской зоне',
  western: 'Западной зоне',
  eastern: 'Восточной зоне',
  northern: 'Северной зоне',
};

/** Ночь этого дня: в какой зоне и по какой вилке на человека; null — ночи нет. */
function nightOf(
  day: EstimateDay, lastDayNum: number, origin: TripOrigin, bi: 0 | 1 | 2,
): { zone: ZoneId; price: [number, number] } | null {
  if (day.type === 'departure' || day.day === lastDayNum) return null;
  if (day.realTour?.lodgingIncluded === true) return null;
  // В зоне не ночуют — ночь считается там, где ночуют на самом деле.
  const sleepZone = sleepZoneOf(day.zone);
  if (nightIsAtHome(origin, sleepZone)) return null;
  const acc = ZONE_ACCOMMODATION[sleepZone];
  const nightPrice = acc.pricePerNight[bi] || acc.pricePerNight[0];
  return { zone: sleepZone, price: [Math.round(nightPrice * 0.8), Math.round(nightPrice * 1.2)] };
}

// ── Вилка на человека ────────────────────────────────────────────────────────

export interface PriceBreakdown {
  activities: [number, number];
  accommodation: [number, number];
  transport: [number, number];
  perPersonTotal: [number, number];
  /**
   * Из чего сложены активности (#2223): сколько дней по цене тура оператора,
   * сколько по ориентиру вида активности (тура нет — цена не тура, а
   * справочная вилка), и сколько туров в сумму НЕ вошли, потому что их цена
   * не за человека. Без этого одна цифра выдавала бы оценку за цену.
   */
  activityPricing: {
    tourPriced: number; estimated: number; excluded: number;
    /**
     * Туры без цены для этой группы (#2304): группа вне ступеней цены
     * оператора или цену не удалось проверить. В сумму не идут.
     */
    unpriced: number;
  };
}

export function calculatePriceBreakdown(days: EstimateDay[], profile: Pick<EstimateProfile, 'budgetTier' | 'tripOrigin'>): PriceBreakdown {
  const bi = budgetIndex(profile.budgetTier);
  const nightCount = Math.max(0, days.length - 1);

  // Активности. Цена тура оператора — только если она за человека: цену
  // группы или дня сложить как цену человека значило бы соврать в итоге
  // (#2223); такой тур в сумму не идёт и называется отдельно. День без тура —
  // справочная вилка вида активности: это ориентир, и он тоже назван отдельно.
  // Продолжение многодневного тура (цена 0, учтена в первом дне) не считается.
  let actFrom = 0;
  let actTo = 0;
  const activityPricing = { tourPriced: 0, estimated: 0, excluded: 0, unpriced: 0 };
  for (const d of days) {
    if (d.type !== 'activity' && d.type !== 'buffer') continue;
    // Цены тура для группы нет — ни цена, ни ориентир: справочная вилка вида
    // активности на месте тура выдала бы себя за его цену.
    if (d.priceMissing) { activityPricing.unpriced++; continue; }
    if (d.realPrice) {
      if (d.realTour && d.realTour.priceUnit !== 'per_person') { activityPricing.excluded++; continue; }
      actFrom += d.realPrice;
      actTo += Math.round(d.realPrice * TOUR_PRICE_HEADROOM);
      activityPricing.tourPriced++;
      continue;
    }
    if (d.priceFrom > 0 || d.priceTo > 0) activityPricing.estimated++;
    actFrom += d.priceFrom;
    actTo += d.priceTo;
  }

  // Ночёвки. Оценка по зоне — только за те ночи, которые турист ДЕЙСТВИТЕЛЬНО
  // оплачивает отдельно.
  //
  // Замер 20.09: у тура ID9 «Камчатской рыбалки» в составе прямым текстом
  // «Проживание на базе 5 ночей» при цене 140 000 ₽, а этот цикл прибавлял
  // ночь за каждый не-отъездный день безусловно. Западная зона при comfort —
  // 20 000 ₽/ночь: семидневный план показывал ещё 96 000–160 000 ₽
  // «проживания», которого турист не платит.
  //
  // `null` (не разобрали состав) считается как «платит»: занижать счёт на
  // догадке хуже, чем завысить и сказать об этом вслух — предупреждение
  // ставит `recommendTrip`.
  //
  // У местного ночь в своей зоне не считается вовсе (lib/planner/trip-origin):
  // он ночует у себя. Допущение о доме названо словами в предупреждениях —
  // молча занижать счёт на догадке об адресе нельзя.
  //
  // У ПОСЛЕДНЕГО дня поездки ночи нет — человек либо улетает, либо едет
  // домой. Правило одно на оба случая: раньше пропускался только день с
  // типом `departure`, и у местного (у которого такого дня нет вовсе) ночей
  // выходило на одну больше, чем он проводит вне дома.
  const origin = asTripOrigin(profile.tripOrigin);
  const lastDayNum = days.length > 0 ? days[days.length - 1]!.day : 0;
  let accFrom = 0;
  let accTo = 0;
  for (const day of days) {
    const night = nightOf(day, lastDayNum, origin, bi);
    if (!night) continue;
    accFrom += night.price[0];
    accTo += night.price[1];
  }
  if (nightCount === 0) { accFrom = 0; accTo = 0; }

  // Transport — travel days + transfers
  // Трансферы аэропорта — только у прилетающего: местный туда не едет.
  const travelDays = days.filter(d => d.type === 'travel');
  const [transferFrom, transferTo] = paysAirportTransfers(origin) ? AIRPORT_TRANSFER : [0, 0];
  const transFrom = travelDays.reduce((s, d) => s + d.priceFrom, 0) + transferFrom;
  const transTo   = travelDays.reduce((s, d) => s + d.priceTo, 0) + transferTo;

  return {
    activities: [actFrom, actTo],
    accommodation: [accFrom, accTo],
    transport: [transFrom, transTo],
    perPersonTotal: [actFrom + accFrom + transFrom, actTo + accTo + transTo],
    activityPricing,
  };
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
  /** Цена оператора или ориентир по средним ценам. */
  source: 'tour' | 'estimate';
  /** Пояснение, если в строке есть допущение. */
  note?: string;
}

export interface GroupEstimate {
  /** Сколько человек в смете: взрослые и дети. */
  people: number;
  lines: EstimateLine[];
  /** Сумма строк с ценой. */
  total: [number, number];
  /** Итог, делённый на состав, — для сравнения с вилкой на человека. */
  perPerson: [number, number];
  /** Подписи строк без цены: в итог не вошли. */
  unpriced: string[];
  /** Сколько итога — цены туров операторов, сколько — ориентир. */
  fromTours: [number, number];
  fromEstimates: [number, number];
  /** Допущения сметы словами: показываются рядом с итогом. */
  assumptions: string[];
}

const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU');
const peopleWord = (n: number) => `${n} чел.`;
const dayWord = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'день' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'дня' : 'дней');
const nightWord = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'ночь' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'ночи' : 'ночей');

const times = ([a, b]: [number, number], k: number): [number, number] => [a * k, b * k];

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
  // Без данных о туре цена считается за человека — так же, как в вилке на
  // человека (`calculatePriceBreakdown`): одна смета, одно правило.
  const unit = day.realTour ? day.realTour.priceUnit : 'per_person';
  const label = `Тур «${day.title}», день ${day.day}`;
  if (unit !== 'per_person' && unit !== 'per_tour' && unit !== 'per_day_per_person') {
    // Незнакомую единицу смета не толкует как «за человека»: так же молчит о
    // ней и витрина (lib/tours/price-label, priceFromUnit).
    return {
      kind: 'tour', label, basis: `${fmt(price)} ₽`, total: null, source: 'tour',
      note: unit ? `Единица цены «${unit}» не распознана — сумму смотрите в карточке тура.` : 'Не указано, за что цена тура, — сумму смотрите в карточке тура.',
    };
  }

  const tourDays = unit === 'per_day_per_person' ? (day.realTour?.durationDays ?? runLength(day, days)) : 1;
  const one = (p: number) => bookingTotal({
    basePrice: p, priceUnit: unit, participants: people,
    duration: { multi_day_count: tourDays, duration_hours: null },
  });
  const cap = day.realTour?.maxParticipants ?? 0;
  const groups = unit === 'per_tour' && cap > 0 ? Math.ceil(people / cap) : 1;
  const total: [number, number] = [one(price) * groups, one(Math.round(price * TOUR_PRICE_HEADROOM)) * groups];

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

/**
 * Смета плана на группу построчно.
 *
 * Состав — взрослые и дети; дети считаются по цене взрослого: скидок
 * платформа не знает, и смета так и говорит (строка «Дети» не заводится —
 * это допущение, а не цена).
 */
export function estimateGroup(days: EstimateDay[], profile: EstimateProfile): GroupEstimate {
  const people = Math.max(1, profile.adults + profile.children.length);
  const bi = budgetIndex(profile.budgetTier);
  const origin = asTripOrigin(profile.tripOrigin);
  const lines: EstimateLine[] = [];

  // Активности: туры по своей единице цены, дни без тура — ориентир.
  for (const d of days) {
    if (d.type !== 'activity' && d.type !== 'buffer') continue;
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
    if (d.priceFrom <= 0 && d.priceTo <= 0) continue;
    lines.push({
      kind: 'activity', label: `«${d.title}», день ${d.day}`,
      basis: `${fmt(d.priceFrom)}–${fmt(d.priceTo)} ₽ × ${peopleWord(people)}`,
      total: times([d.priceFrom, d.priceTo], people), source: 'estimate',
      note: 'Тура на этот день нет — справочная цена вида активности.',
    });
  }

  // Ночи — по зоне, где ночуют, одной строкой на зону.
  if (days.length > 1) {
    const lastDayNum = days[days.length - 1]!.day;
    const byZone = new Map<ZoneId, { nights: number; sum: [number, number] }>();
    for (const day of days) {
      const night = nightOf(day, lastDayNum, origin, bi);
      if (!night) continue;
      const z = byZone.get(night.zone) ?? { nights: 0, sum: [0, 0] as [number, number] };
      z.nights++;
      z.sum = [z.sum[0] + night.price[0], z.sum[1] + night.price[1]];
      byZone.set(night.zone, z);
    }
    for (const [zone, z] of byZone) {
      lines.push({
        kind: 'lodging', label: `Проживание в ${ZONE_GENITIVE[zone]}`,
        basis: `${z.nights} ${nightWord(z.nights)} × ${peopleWord(people)}`,
        total: times(z.sum, people), source: 'estimate',
        note: 'Ориентир по зоне и уровню размещения; ночи, включённые в туры, не считаны.',
      });
    }
  }

  // Переезды и трансферы аэропорта.
  for (const d of days) {
    if (d.type !== 'travel') continue;
    if (d.priceFrom <= 0 && d.priceTo <= 0) continue;
    lines.push({
      kind: 'transport', label: `${d.title}, день ${d.day}`,
      basis: `${fmt(d.priceFrom)}–${fmt(d.priceTo)} ₽ × ${peopleWord(people)}`,
      total: times([d.priceFrom, d.priceTo], people), source: 'estimate',
    });
  }
  if (paysAirportTransfers(origin) && days.length > 0) {
    lines.push({
      kind: 'transport', label: 'Трансферы аэропорта',
      basis: `${fmt(AIRPORT_TRANSFER[0])}–${fmt(AIRPORT_TRANSFER[1])} ₽ × ${peopleWord(people)}`,
      total: times(AIRPORT_TRANSFER, people), source: 'estimate',
    });
  }

  const sum = (pick: (l: EstimateLine) => boolean): [number, number] =>
    lines.filter((l) => l.total && pick(l)).reduce<[number, number]>(
      (acc, l) => [acc[0] + l.total![0], acc[1] + l.total![1]], [0, 0]);
  const total = sum(() => true);

  const assumptions: string[] = [];
  if (profile.children.length > 0) {
    assumptions.push('Дети посчитаны по цене взрослого: скидок платформа не знает — уточняйте у оператора.');
  }

  return {
    people,
    lines,
    total,
    perPerson: [Math.round(total[0] / people), Math.round(total[1] / people)],
    unpriced: lines.filter((l) => !l.total).map((l) => l.label),
    fromTours: sum((l) => l.source === 'tour'),
    fromEstimates: sum((l) => l.source === 'estimate'),
    assumptions,
  };
}
