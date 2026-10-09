/**
 * Сторож формулы: смета плана на группу (#2304, lib/planner/estimate).
 *
 * Разбор конструктора «Лагуны Экспедиции» 09.10: у них смета — строки
 * «кол-во × цена» и итог на группу, у нас была одна вилка на человека, и тур
 * с ценой за группу из неё выпадал. Здесь держится сама арифметика, без базы
 * и экрана:
 *
 *   — одна формула: когда все туры за человека, итог группы — это ровно вилка
 *     на человека, умноженная на состав (calculatePriceBreakdown);
 *   — тур считается по своей единице цены: за человека — на каждого, за
 *     группу — на каждую группу по вместимости, за день — на каждый день тура;
 *   — чего не знаем, то «цена не указана», а не ноль, и в итог не входит;
 *   — ночи — по зоне, где ночуют, без последней ночи, ночей дома и ночей,
 *     включённых в тур.
 */
import { describe, it, expect } from 'vitest';
import {
  estimateGroup, calculatePriceBreakdown,
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
// резервный день, вылет. Все туры — за человека.
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
    it(`все туры за человека: итог группы = вилка на человека × ${people} (${p.tripOrigin}, ${p.budgetTier})`, () => {
      const pb = calculatePriceBreakdown(VISITOR_PLAN, p);
      const e = estimateGroup(VISITOR_PLAN, p);
      expect(e.people).toBe(people);
      expect(e.total).toEqual([pb.perPersonTotal[0] * people, pb.perPersonTotal[1] * people]);
      expect(e.perPerson).toEqual(pb.perPersonTotal);
      expect(e.unpriced).toEqual([]);
    });
  }

  it('итог — это сумма цен туров и ориентиров, без остатка', () => {
    const e = estimateGroup(VISITOR_PLAN, profile({ tripOrigin: 'visitor' }));
    expect([e.fromTours[0] + e.fromEstimates[0], e.fromTours[1] + e.fromEstimates[1]]).toEqual(e.total);
    expect(e.fromTours).toEqual([(10000 + 20000) * 2, Math.round((10000 + 20000) * 1.2) * 2]);
  });

  it('удалили день — итог уменьшился ровно на строку этого дня', () => {
    const p = profile({ tripOrigin: 'local' });
    const before = estimateGroup(VISITOR_PLAN, p);
    const removed = tourLines(before).find((l) => l.label.includes('Рыбалка'))!;
    const after = estimateGroup(VISITOR_PLAN.filter((d) => d.title !== 'Рыбалка'), p);
    // У местного ночи на западе остаются от дня переезда, а ночь дня рыбалки уходит вместе с ним.
    const nightOfFishingDay = (lodging(before).find((l) => l.label.includes('Западной'))?.total ?? [0, 0])[0]
      - (lodging(after).find((l) => l.label.includes('Западной'))?.total ?? [0, 0])[0];
    expect(before.total[0] - after.total[0]).toBe(removed.total![0] + nightOfFishingDay);
    expect(tourLines(after).some((l) => l.label.includes('Рыбалка'))).toBe(false);
  });
});

describe('тур — по своей единице цены', () => {
  it('за человека — на каждого', () => {
    const e = estimateGroup([day(1, 'activity', { title: 'Вулкан', realPrice: 12000, realTour: tour('t', 'per_person', 10) })], profile({ adults: 3 }));
    const [l] = tourLines(e);
    expect(plain(l!.basis)).toBe('12 000 ₽ × 3 чел.');
    expect(l!.total).toEqual([36000, 43200]);
    expect(l!.source).toBe('tour');
  });

  it('за группу — один раз, если группа помещается', () => {
    const e = estimateGroup([day(1, 'activity', { realPrice: 30000, realTour: tour('t', 'per_tour', 10) })], profile({ adults: 2 }));
    const [l] = tourLines(e);
    expect(plain(l!.basis)).toBe('30 000 ₽ за группу');
    expect(l!.total).toEqual([30000, 36000]);
    expect(l!.note).toBeUndefined();
  });

  it('за группу — на каждую группу по вместимости тура', () => {
    const e = estimateGroup([day(1, 'activity', { realPrice: 30000, realTour: tour('t', 'per_tour', 4) })], profile({ adults: 6 }));
    const [l] = tourLines(e);
    expect(plain(l!.basis)).toBe('30 000 ₽ за группу × 2 (до 4 чел. в группе)');
    expect(l!.total).toEqual([60000, 72000]);
  });

  it('за группу без вместимости — одна группа, и это сказано', () => {
    const e = estimateGroup([day(1, 'activity', { realPrice: 30000, realTour: tour('t', 'per_tour') })], profile({ adults: 12 }));
    const [l] = tourLines(e);
    expect(l!.total).toEqual([30000, 36000]);
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
    expect(tourLines(e)[0]!.total).toEqual([30000, 36000]);
  });

  it('многодневный тур за человека считается один раз, а не за каждый день', () => {
    const t = tour('multi', 'per_person', 10);
    const e = estimateGroup([
      day(1, 'activity', { realPrice: 90000, realTour: t }),
      day(2, 'activity', { realTour: t }),
    ], profile({ adults: 2 }));
    expect(e.fromTours).toEqual([180000, 216000]);
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
    expect(e.total).toEqual([20000, 24000]);
  });

  it('единица цены не записана — тоже не ноль, а «не указано»', () => {
    const e = estimateGroup([day(1, 'activity', { realPrice: 50000, realTour: tour('x') })], profile());
    expect(tourLines(e)[0]!.total).toBeNull();
    expect(tourLines(e)[0]!.note).toMatch(/Не указано, за что цена тура/);
    expect(e.total).toEqual([0, 0]);
  });

  it('цена без данных о туре — за человека, как в вилке на человека', () => {
    const days = [day(1, 'activity', { realPrice: 8000 })];
    const e = estimateGroup(days, profile({ adults: 3 }));
    expect(e.total).toEqual([24000, Math.round(8000 * 1.2) * 3]);
    expect(e.perPerson).toEqual(calculatePriceBreakdown(days, profile()).perPersonTotal);
  });
});

describe('ночи — по зоне, где ночуют', () => {
  it('у последнего дня ночи нет: три дня — две ночи', () => {
    const e = estimateGroup([day(1, 'arrival'), day(2, 'activity'), day(3, 'departure')], profile({ tripOrigin: 'visitor' }));
    const [l] = lodging(e);
    expect(l!.label).toBe('Проживание в Авачинской зоне');
    expect(plain(l!.basis)).toBe('2 ночи × 2 чел.');
    // комфорт, Авачинская: 7 000 ±20% за ночь на человека.
    expect(l!.total).toEqual([2 * 5600 * 2, 2 * 8400 * 2]);
  });

  it('у местного ночи дома не считаются, ночи на выезде — считаются', () => {
    const e = estimateGroup([
      day(1, 'activity'),
      day(2, 'activity', { zone: 'western' }),
      day(3, 'activity', { zone: 'western' }),
    ], profile({ tripOrigin: 'local' }));
    expect(lodging(e).map((l) => l.label)).toEqual(['Проживание в Западной зоне']);
    expect(plain(lodging(e)[0]!.basis)).toBe('1 ночь × 2 чел.');
  });

  it('ночь, включённая в тур, не считается отдельно', () => {
    const e = estimateGroup([
      day(1, 'activity', { zone: 'western', realPrice: 140000, realTour: tour('base', 'per_person', 8, true) }),
      day(2, 'activity', { zone: 'western', realTour: tour('base', 'per_person', 8, true) }),
      day(3, 'activity', { zone: 'western' }),
    ], profile({ tripOrigin: 'visitor' }));
    expect(lodging(e)).toEqual([]);
  });

  it('в Северной зоне не ночуют — ночь считается в Авачинской', () => {
    const e = estimateGroup([day(1, 'activity', { zone: 'northern' }), day(2, 'activity')], profile({ tripOrigin: 'visitor' }));
    expect(lodging(e).map((l) => l.label)).toEqual(['Проживание в Авачинской зоне']);
  });

  it('однодневный план — без строк проживания', () => {
    expect(lodging(estimateGroup([day(1, 'activity')], profile({ tripOrigin: 'visitor' })))).toEqual([]);
  });

  it('строка проживания — ориентир, а не цена', () => {
    const e = estimateGroup([day(1, 'arrival'), day(2, 'departure')], profile({ tripOrigin: 'visitor' }));
    expect(lodging(e)[0]!.source).toBe('estimate');
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

  it('трансферы аэропорта — у прилетающего, на каждого; у местного их нет', () => {
    const visitor = estimateGroup(VISITOR_PLAN, profile({ tripOrigin: 'visitor', adults: 3 }));
    const transfer = visitor.lines.find((l) => l.label === 'Трансферы аэропорта')!;
    expect(transfer.total).toEqual([7500, 15000]);
    expect(estimateGroup(VISITOR_PLAN, profile({ tripOrigin: 'local' })).lines.some((l) => l.label === 'Трансферы аэропорта')).toBe(false);
  });

  it('день без тура — ориентир вида активности на каждого', () => {
    const e = estimateGroup(VISITOR_PLAN, profile());
    const walk = e.lines.find((l) => l.label.includes('Прогулка'))!;
    expect(walk.kind).toBe('activity');
    expect(walk.source).toBe('estimate');
    expect(walk.total).toEqual([6000, 12000]);
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
    expect(e.total).toEqual([20000, 24000]);
  });

  it('вилка на человека: тур без цены для группы — не ориентир и не цена, а «без цены»', () => {
    const pb = calculatePriceBreakdown([
      day(1, 'activity', { realTour: tour('krai', 'per_person', 15), priceMissing: 'нет цены', priceFrom: 0, priceTo: 0 }),
      day(2, 'activity', { realPrice: 10000, realTour: tour('v', 'per_person', 10) }),
    ], profile());
    expect(pb.activityPricing).toEqual({ tourPriced: 1, estimated: 0, excluded: 0, unpriced: 1 });
    expect(pb.activities).toEqual([10000, 12000]);
  });
});
