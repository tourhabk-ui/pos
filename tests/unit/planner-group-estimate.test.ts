/**
 * Сторож формулы: смета плана на группу (#2304, lib/planner/estimate).
 *
 * Разбор конструктора «Лагуны Экспедиции» 09.10: у них смета — строки
 * «кол-во × цена» и итог на группу, у нас была одна вилка на человека, и тур
 * с ценой за группу из неё выпадал. Здесь держится сама арифметика, без базы
 * и экрана:
 *
 *   — одна формула: когда все туры за человека, итог группы — это ровно сумма
 *     цен туров на человека, умноженная на состав (calculatePriceBreakdown);
 *   — тур считается по своей единице цены: за человека — на каждого, за
 *     группу — на каждую группу по вместимости, за день — на каждый день тура;
 *   — в сумме только цены с источником (слово владельца 14.11 «5 -1»): дни
 *     без тура, ночи, переезды и трансфер — строки без суммы, кто называет
 *     цену — сказано; числа, оставшиеся в днях старых планов, не считаются;
 *   — ночи — по зоне, где ночуют, без последней ночи, ночей дома и ночей,
 *     включённых в тур.
 */
import { dayPriceLine } from '@/lib/planner/day-price';
import { describe, it, expect } from 'vitest';
import {
  estimateGroup, calculatePriceBreakdown, OPEN_PRICE_WORDS,
  type EstimateDay, type EstimateProfile, type GroupEstimate,
} from '@/lib/planner/estimate';
import { bookingTotal } from '@/lib/tours/booking-total';

type Tour = NonNullable<EstimateDay['realTour']>;

const day = (n: number, type: EstimateDay['type'], extra: Partial<EstimateDay> = {}): EstimateDay => ({
  day: n, type, zone: 'avachinsky', title: `День ${n}`, priceFrom: 0, priceTo: 0, ...extra,
});
const tour = (tourId: string, priceUnit?: string, maxParticipants?: number, lodgingIncluded: boolean | null = null): Tour => ({
  tourId, lodgingIncluded,
  ...(priceUnit !== undefined ? { priceUnit } : {}),
  ...(maxParticipants !== undefined ? { maxParticipants } : {}),
});
const profile = (over: Partial<EstimateProfile> = {}): EstimateProfile => ({
  adults: 2, children: [], budgetTier: 'comfort', tripOrigin: 'local', ...over,
});
const tourLines = (e: GroupEstimate) => e.lines.filter((l) => l.kind === 'tour');
const lodging = (e: GroupEstimate) => e.lines.filter((l) => l.kind === 'lodging');
/** Текст без неразрывных пробелов: toLocaleString('ru-RU') делит тысячи U+00A0. */
const plain = (s: string) => s.replace(/ /g, ' ');

// Прилетающая семья: день прилёта, тур, день без тура, переезд, тур на западе,
// резервный день, вылет. Все туры — за человека. У дней без тура стоят числа,
// какие движок ставил до 14.11: так выглядят дни сохранённых тогда планов, и
// в сумму они идти не должны.
const VISITOR_PLAN: EstimateDay[] = [
  day(1, 'arrival'),
  day(2, 'activity', { title: 'Авачинский', realPrice: 10000, realTour: tour('t-1', 'per_person', 10) }),
  day(3, 'activity', { title: 'Прогулка', priceFrom: 3000, priceTo: 6000 }),
  day(4, 'travel', { zone: 'western', title: 'Переезд на запад', priceFrom: 5000, priceTo: 8000 }),
  day(5, 'activity', { zone: 'western', title: 'Рыбалка', realPrice: 20000, realTour: tour('t-2', 'per_person', 8) }),
  day(6, 'buffer', { title: 'Резерв', priceFrom: 0, priceTo: 5000 }),
  day(7, 'departure'),
];

describe('одна формула с вилкой на человека', () => {
  for (const p of [
    profile({ tripOrigin: 'visitor' }),
    profile({ tripOrigin: 'visitor', adults: 2, children: [7], budgetTier: 'economy' }),
    profile({ tripOrigin: 'local', adults: 4, budgetTier: 'premium' }),
  ]) {
    const people = p.adults + p.children.length;
    it(`все туры за человека: итог группы = цены туров на человека × ${people} (${p.tripOrigin}, ${p.budgetTier})`, () => {
      const pb = calculatePriceBreakdown(VISITOR_PLAN);
      const e = estimateGroup(VISITOR_PLAN, p);
      expect(e.people).toBe(people);
      expect(pb.tours).toEqual([30000, 30000]);
      expect(e.total).toEqual([pb.tours[0] * people, pb.tours[1] * people]);
      expect(e.perPerson).toEqual(pb.tours);
      // Без суммы — ровно строки без источника цены, и каждая названа.
      expect(e.unpriced).toEqual(e.lines.filter((l) => !l.total).map((l) => l.label));
      for (const l of e.lines.filter((x) => x.source === 'open')) expect(l.total, l.label).toBeNull();
    });
  }

  it('итог — это только цены туров и выбранных предложений, без остатка', () => {
    const e = estimateGroup(VISITOR_PLAN, profile({ tripOrigin: 'visitor' }));
    expect([e.fromTours[0] + e.fromOffers[0], e.fromTours[1] + e.fromOffers[1]]).toEqual(e.total);
    expect(e.fromTours).toEqual([(10000 + 20000) * 2, (10000 + 20000) * 2]);
  });

  it('числа в днях без тура (старые планы) в сумму не идут ни строкой, ни итогом', () => {
    const e = estimateGroup(VISITOR_PLAN, profile({ tripOrigin: 'visitor', budgetTier: 'premium' }));
    expect(e.total).toEqual([60000, 60000]);
    const text = e.lines.map((l) => `${l.basis} ${l.note ?? ''}`).join(' ');
    for (const n of ['3 000', '6 000', '5 000', '8 000', '2 500']) expect(plain(text)).not.toContain(n);
  });

  it('удалили день — итог уменьшился ровно на строку этого дня', () => {
    const p = profile({ tripOrigin: 'local' });
    const before = estimateGroup(VISITOR_PLAN, p);
    const removed = tourLines(before).find((l) => l.label.includes('Рыбалка'))!;
    const after = estimateGroup(VISITOR_PLAN.filter((d) => d.title !== 'Рыбалка'), p);
    expect(before.total[0] - after.total[0]).toBe(removed.total![0]);
    expect(tourLines(after).some((l) => l.label.includes('Рыбалка'))).toBe(false);
  });
});

describe('тур — по своей единице цены', () => {
  it('за человека — на каждого', () => {
    const e = estimateGroup([day(1, 'activity', { title: 'Вулкан', realPrice: 12000, realTour: tour('t', 'per_person', 10) })], profile({ adults: 3 }));
    const [l] = tourLines(e);
    expect(plain(l!.basis)).toBe('12 000 ₽ × 3 чел.');
    expect(l!.total).toEqual([36000, 36000]);
    expect(l!.source).toBe('tour');
  });

  it('за группу — один раз, если группа помещается', () => {
    const e = estimateGroup([day(1, 'activity', { realPrice: 30000, realTour: tour('t', 'per_tour', 10) })], profile({ adults: 2 }));
    const [l] = tourLines(e);
    expect(plain(l!.basis)).toBe('30 000 ₽ за группу');
    expect(l!.total).toEqual([30000, 30000]);
    expect(l!.note).toBeUndefined();
  });

  it('за группу — на каждую группу по вместимости тура', () => {
    const e = estimateGroup([day(1, 'activity', { realPrice: 30000, realTour: tour('t', 'per_tour', 4) })], profile({ adults: 6 }));
    const [l] = tourLines(e);
    expect(plain(l!.basis)).toBe('30 000 ₽ за группу × 2 (до 4 чел. в группе)');
    expect(l!.total).toEqual([60000, 60000]);
  });

  it('за группу без вместимости — одна группа, и это сказано', () => {
    const e = estimateGroup([day(1, 'activity', { realPrice: 30000, realTour: tour('t', 'per_tour') })], profile({ adults: 12 }));
    const [l] = tourLines(e);
    expect(l!.total).toEqual([30000, 30000]);
    expect(l!.note).toMatch(/Вместимость группы у тура не указана/);
  });

  it('за день на человека — на каждый день тура и каждого; дни продолжения строк не дают', () => {
    const t = tour('multi', 'per_day_per_person', 10);
    const e = estimateGroup([
      day(1, 'activity', { title: 'Сплав', realPrice: 5000, realTour: t }),
      day(2, 'activity', { title: 'Сплав — день 2 из 3', realTour: t }),
      day(3, 'activity', { title: 'Сплав — день 3 из 3', realTour: t }),
    ], profile({ adults: 2 }));
    expect(tourLines(e)).toHaveLength(1);
    expect(e.lines.filter((l) => l.kind === 'activity')).toEqual([]);
    expect(plain(tourLines(e)[0]!.basis)).toBe('5 000 ₽ × 3 дня × 2 чел.');
    expect(tourLines(e)[0]!.total).toEqual([30000, 30000]);
  });

  it('многодневный тур за человека считается один раз, а не за каждый день', () => {
    const t = tour('multi', 'per_person', 10);
    const e = estimateGroup([
      day(1, 'activity', { realPrice: 90000, realTour: t }),
      day(2, 'activity', { realTour: t }),
    ], profile({ adults: 2 }));
    expect(e.fromTours).toEqual([180000, 180000]);
  });

  it('незнакомая единица цены — «цена не указана»: строка есть, в итог не входит', () => {
    const e = estimateGroup([
      day(1, 'activity', { title: 'Вертолёт', realPrice: 400000, realTour: tour('h', 'per_vehicle', 6) }),
      day(2, 'activity', { title: 'Вулкан', realPrice: 10000, realTour: tour('v', 'per_person', 10) }),
    ], profile({ adults: 2 }));
    const heli = tourLines(e).find((l) => l.label.includes('Вертолёт'))!;
    expect(heli.total).toBeNull();
    expect(heli.note).toMatch(/«per_vehicle» не распознана/);
    expect(e.unpriced).toEqual([heli.label]);
    expect(e.total).toEqual([20000, 20000]);
  });

  it('единица цены не записана — тоже не ноль, а «не указано»', () => {
    const e = estimateGroup([day(1, 'activity', { realPrice: 50000, realTour: tour('x') })], profile());
    expect(tourLines(e)[0]!.total).toBeNull();
    expect(tourLines(e)[0]!.note).toMatch(/Не указано, за что цена тура/);
    expect(e.total).toEqual([0, 0]);
  });

  // Разбор 14.11, смета-6: карточка дня писала «за что — не записано», а смета
  // умножала ту же цену на всю группу. Единицы нет — суммы нет, нигде.
  it('цена без данных о туре — не «за человека»: в итог не входит, как и на карточке', () => {
    const days = [day(1, 'activity', { realPrice: 8000 })];
    const e = estimateGroup(days, profile({ adults: 3 }));
    const [line] = tourLines(e);
    expect(line!.total).toBeNull();
    expect(line!.note).toMatch(/Не указано, за что цена тура/);
    expect(e.total).not.toEqual([8000 * 3, 8000 * 3]);
    const pp = calculatePriceBreakdown(days);
    expect(pp.tours).toEqual([0, 0]);
    expect(pp.activityPricing.excluded).toBe(1);
    expect(dayPriceLine(days[0]!).replace(/[\u00a0\u202f]/g, ' ')).toBe('8 000 ₽ за что — не записано');
  });
});

describe('ночи — по зоне, где ночуют', () => {
  it('у последнего дня ночи нет: три дня — две ночи', () => {
    const e = estimateGroup([day(1, 'arrival'), day(2, 'activity'), day(3, 'departure')], profile({ tripOrigin: 'visitor' }));
    const [l] = lodging(e);
    expect(l!.label).toBe('Проживание в Авачинской зоне');
    expect(l!.basis).toBe(`2 ночи — ${OPEN_PRICE_WORDS.lodging}`);
    // Суммы нет: ночь по зоне была числом, зашитым в код (слово владельца 14.11 «5 -1»).
    expect(l!.total).toBeNull();
  });

  it('у местного ночи дома не считаются, ночи на выезде — считаются', () => {
    const e = estimateGroup([
      day(1, 'activity'),
      day(2, 'activity', { zone: 'western' }),
      day(3, 'activity', { zone: 'western' }),
    ], profile({ tripOrigin: 'local' }));
    expect(lodging(e).map((l) => l.label)).toEqual(['Проживание в Западной зоне']);
    expect(lodging(e)[0]!.basis).toBe(`1 ночь — ${OPEN_PRICE_WORDS.lodging}`);
  });

  it('ночь, включённая в тур, не считается отдельно; ночь после последнего дня тура — считается (Б32)', () => {
    // Двухдневный тур покрывает одну ночь — между днями 1 и 2. Ночь после
    // дня 2 (последний день тура) уже не его: до #3199 она выпадала из сметы.
    const e = estimateGroup([
      day(1, 'activity', { zone: 'western', realPrice: 140000, realTour: tour('base', 'per_person', 8, true) }),
      day(2, 'activity', { zone: 'western', realTour: tour('base', 'per_person', 8, true) }),
      day(3, 'activity', { zone: 'western' }),
    ], profile({ tripOrigin: 'visitor' }));
    expect(lodging(e).map((l) => l.basis)).toEqual([`1 ночь — ${OPEN_PRICE_WORDS.lodging}`]);
  });

  it('в Северной зоне не ночуют — ночь считается в Авачинской', () => {
    const e = estimateGroup([day(1, 'activity', { zone: 'northern' }), day(2, 'activity')], profile({ tripOrigin: 'visitor' }));
    expect(lodging(e).map((l) => l.label)).toEqual(['Проживание в Авачинской зоне']);
  });

  it('однодневный план — без строк проживания', () => {
    expect(lodging(estimateGroup([day(1, 'activity')], profile({ tripOrigin: 'visitor' })))).toEqual([]);
  });

  it('строка проживания — без суммы, цену называет хозяин жилья; уровень жилья сумму не меняет', () => {
    for (const budgetTier of ['economy', 'comfort', 'premium'] as const) {
      const e = estimateGroup([day(1, 'arrival'), day(2, 'departure')], profile({ tripOrigin: 'visitor', budgetTier }));
      expect(lodging(e)[0]!.source).toBe('open');
      expect(lodging(e)[0]!.total).toBeNull();
      expect(e.unpriced).toContain('Проживание в Авачинской зоне');
    }
  });
});

describe('состав, трансферы, допущения', () => {
  it('дети входят в состав и названы допущением о цене', () => {
    const e = estimateGroup(VISITOR_PLAN, profile({ adults: 2, children: [5, 9] }));
    expect(e.people).toBe(4);
    expect(e.assumptions.join(' ')).toMatch(/Дети посчитаны по цене взрослого/);
  });

  it('без детей допущения о детях нет', () => {
    expect(estimateGroup(VISITOR_PLAN, profile()).assumptions).toEqual([]);
  });

  it('трансферы аэропорта — у прилетающего строка без суммы, цену называет перевозчик; у местного строки нет', () => {
    const visitor = estimateGroup(VISITOR_PLAN, profile({ tripOrigin: 'visitor', adults: 3 }));
    const transfer = visitor.lines.find((l) => l.label === 'Трансферы аэропорта')!;
    expect(transfer.total).toBeNull();
    expect(transfer.basis).toBe(OPEN_PRICE_WORDS.transport);
    expect(estimateGroup(VISITOR_PLAN, profile({ tripOrigin: 'local' })).lines.some((l) => l.label === 'Трансферы аэропорта')).toBe(false);
  });

  it('переезд — строка без суммы, цену называет перевозчик', () => {
    const e = estimateGroup(VISITOR_PLAN, profile());
    const travel = e.lines.find((l) => l.label.includes('Переезд на запад'))!;
    expect(travel.kind).toBe('transport');
    expect(travel.total).toBeNull();
    expect(travel.basis).toBe(OPEN_PRICE_WORDS.transport);
  });

  it('день занятий без тура — строка без суммы, цену называет исполнитель; прилёт и отъезд строк не дают', () => {
    const e = estimateGroup(VISITOR_PLAN, profile());
    const walk = e.lines.find((l) => l.label.includes('Прогулка'))!;
    expect(walk.kind).toBe('activity');
    expect(walk.source).toBe('open');
    expect(walk.total).toBeNull();
    expect(walk.basis).toBe(OPEN_PRICE_WORDS.activity);
    expect(e.lines.some((l) => l.label.includes('День 1') || l.label.includes('День 7'))).toBe(false);
  });

  it('пустой состав не делит на ноль', () => {
    const e = estimateGroup(VISITOR_PLAN, profile({ adults: 0, children: [] }));
    expect(e.people).toBe(1);
    expect(Number.isFinite(e.perPerson[0])).toBe(true);
  });
});

describe('тур — по правилу брони (#2304, шаг 1б)', () => {
  it('нижняя граница строки — ровно сумма брони для этой группы', () => {
    const cases: Array<[string, number]> = [['per_person', 3], ['per_tour', 3], ['per_day_per_person', 3]];
    for (const [unit, people] of cases) {
      const t = { ...tour('t', unit, 10), durationDays: 4 };
      const e = estimateGroup([day(1, 'activity', { realPrice: 12000, realTour: t })], profile({ adults: people }));
      const expected = bookingTotal({
        basePrice: 12000, priceUnit: unit, participants: people,
        duration: { multi_day_count: 4, duration_hours: null },
      });
      expect(tourLines(e)[0]!.total![0], unit).toBe(expected);
    }
  });

  it('«за день» — дни брони, а не дни, что тур занял в плане', () => {
    // Бронь считает дни тура по multi_day_count; план мог поставить тур
    // короче (поездка кончилась раньше) — платить всё равно за дни брони.
    const t = { ...tour('fish', 'per_day_per_person', 10), durationDays: 5 };
    const e = estimateGroup([day(1, 'activity', { realPrice: 28000, realTour: t })], profile({ adults: 2 }));
    expect(plain(tourLines(e)[0]!.basis)).toBe('28 000 ₽ × 5 дней × 2 чел.');
    expect(tourLines(e)[0]!.total![0]).toBe(28000 * 5 * 2);
  });

  it('тур в плане дважды — каждая постановка считает свои дни, без задвоения', () => {
    const t = tour('fish', 'per_day_per_person', 10);
    const e = estimateGroup([
      day(1, 'activity', { realPrice: 5000, realTour: t }),
      day(2, 'activity', { realTour: t }),
      day(3, 'activity', { title: 'Отдых' }),
      day(4, 'activity', { realPrice: 5000, realTour: t }),
    ], profile({ adults: 1 }));
    expect(tourLines(e).map((l) => l.total![0])).toEqual([10000, 5000]);
  });

  it('цены для группы нет — строка «цену называет оператор», в итог не входит, дни тура не теряются', () => {
    const t = tour('krai', 'per_person', 15);
    const why = 'Для группы из 2 чел. цену называет оператор отдельно: оставьте заявку, и он пришлёт её.';
    const e = estimateGroup([
      day(1, 'activity', { title: 'Толбачик', realTour: t, priceMissing: why }),
      day(2, 'activity', { title: 'Толбачик — день 2 из 2', realTour: t }),
      day(3, 'activity', { title: 'Вулкан', realPrice: 10000, realTour: tour('v', 'per_person', 10) }),
    ], profile({ adults: 2 }));
    const missing = tourLines(e).find((l) => l.label.includes('Толбачик'))!;
    expect(missing.total).toBeNull();
    expect(missing.basis).toBe('цену называет оператор');
    expect(missing.note).toBe(why);
    expect(tourLines(e)).toHaveLength(2);
    expect(e.unpriced).toEqual([missing.label]);
    expect(e.total).toEqual([20000, 20000]);
  });

  it('сумма на человека: тур без цены для группы — не цена, а «без цены»; день без тура — «открыт»', () => {
    const pb = calculatePriceBreakdown([
      day(1, 'activity', { realTour: tour('krai', 'per_person', 15), priceMissing: 'нет цены', priceFrom: 0, priceTo: 0 }),
      day(2, 'activity', { realPrice: 10000, realTour: tour('v', 'per_person', 10) }),
      day(3, 'activity', { title: 'Прогулка', priceFrom: 3000, priceTo: 6000 }),
    ]);
    expect(pb.activityPricing).toEqual({ tourPriced: 1, open: 1, excluded: 0, unpriced: 1 });
    expect(pb.tours).toEqual([10000, 10000]);
  });
});
