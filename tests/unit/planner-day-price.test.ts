/**
 * Сторож: цена дня плана называет, за что она (#2304, lib/planner/day-price).
 *
 * Карточка дня /planner писала «X — Y ₽ на человека» у любого тура, а у
 * туров «Камчатской рыбалки» цена за группу (196 000 ₽ за неделю на базе) и
 * за человека в день. Чат Кузьмича печатал «— от 196 000 ₽» без единицы, и
 * агент пересказывал её как цену с человека. Одна подпись теперь у карточки,
 * PDF, страницы /trip/<token> и чата — сторож держит и подпись, и то, что все
 * четыре поверхности её зовут.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dayPrice, dayPriceLine } from '@/lib/planner/day-price';
import { formatTripPlanForChat } from '@/lib/kuzmich/trip-plan-tool';
import type { DayPlan } from '@/lib/planner/engine';

const base = { priceFrom: 0, priceTo: 0 };
const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf-8');

describe('подпись цены дня', () => {
  it('тур за группу — «за группу», а не «на человека»', () => {
    expect(dayPrice({ ...base, realPrice: 196000, realTour: { priceUnit: 'per_tour' } }))
      .toEqual({ kind: 'tour', main: '196 000 ₽', unit: 'за группу', label: null });
    expect(dayPriceLine({ ...base, realPrice: 196000, realTour: { priceUnit: 'per_tour' } })).toBe('196 000 ₽ за группу');
  });

  it('за день — «за чел./день», за человека — «за человека»', () => {
    expect(dayPriceLine({ ...base, realPrice: 28000, realTour: { priceUnit: 'per_day_per_person' } })).toBe('28 000 ₽ за чел./день');
    expect(dayPriceLine({ ...base, realPrice: 13000, realTour: { priceUnit: 'per_person' } })).toBe('13 000 ₽ за человека');
  });

  it('незнакомая единица не становится «за человека»', () => {
    expect(dayPriceLine({ ...base, realPrice: 5000, realTour: { priceUnit: 'per_vehicle' } })).toBe('5 000 ₽ за что — не записано');
  });

  it('скидка или надбавка названа рядом с ценой', () => {
    expect(dayPriceLine({ ...base, realPrice: 8500, realTour: { priceUnit: 'per_person', priceLabel: '−15%, последние места' } }))
      .toBe('8 500 ₽ за человека (−15%, последние места)');
  });

  it('цены для группы нет — так и сказано, без числа', () => {
    const p = dayPrice({ priceFrom: 0, priceTo: 0, priceMissing: 'Для группы из 2 чел. цену называет оператор', realTour: { priceUnit: 'per_person' } });
    expect(p.kind).toBe('missing');
    expect(dayPriceLine({ priceFrom: 0, priceTo: 0, priceMissing: 'x' })).toBe('Цену для вашей группы называет оператор');
  });

  it('день продолжения многодневного тура — без цены: она в первом дне', () => {
    expect(dayPrice({ ...base, realTour: { priceUnit: 'per_tour' } })).toEqual({ kind: 'none' });
    expect(dayPriceLine({ ...base, realTour: { priceUnit: 'per_tour' } })).toBe('');
  });

  it('день без тура — ориентир на человека, и слово «ориентир» рядом', () => {
    expect(dayPriceLine({ priceFrom: 1500, priceTo: 5000 })).toBe('1 500 — 5 000 ₽ на человека, ориентир');
  });
});

describe('чат Кузьмича: цена дня с единицей', () => {
  const day = (over: Partial<DayPlan>): DayPlan => ({
    day: 1, type: 'activity', zone: 'western', title: 'Недельный рыболовный тур', description: '',
    activityType: 'fishing', priceFrom: 0, priceTo: 0, coords: [53, 158], defaultTransport: 'jeep',
    allowedTransports: ['jeep'], difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: [],
    ...over,
  });
  const tourOf = (priceUnit: string): DayPlan['realTour'] => ({
    tourId: '11', operatorName: 'Камчатская рыбалка', operatorSlug: 'kr', operatorRating: 0, tourRating: null,
    reviewCount: 0, verified: true, maxParticipants: 8, weatherDependent: false, durationHours: 168,
    priceUnit, lodgingIncluded: true,
  });

  it('тур за группу — «₽/группа»', () => {
    const text = formatTripPlanForChat([day({ realPrice: 196000, realTour: tourOf('per_tour') })], [], null);
    expect(text.replace(/ /g, ' ')).toContain('День 1. Недельный рыболовный тур — от 196 000 ₽/группа');
  });

  it('цены для группы нет — строка с причиной, без числа', () => {
    const why = 'Для группы из 2 чел. цену называет оператор отдельно: оставьте заявку, и он пришлёт её.';
    const text = formatTripPlanForChat([day({ realTour: tourOf('per_person'), priceMissing: why })], [], null);
    expect(text).toContain('День 1. Недельный рыболовный тур\n');
    expect(text).toContain(`   ${why}`);
  });
});

describe('все поверхности плана зовут одну подпись', () => {
  it('карточка дня, PDF, страница плана', () => {
    const client = read('app/planner/_PlannerClient.tsx');
    expect(client).toMatch(/dayPrice\(day\)/);
    expect(client).toMatch(/escapeHtml\(dayPriceLine\(d\)\)/);
    expect(client, 'карточка снова пишет «на человека» у тура').not.toMatch(/fmt\(day\.priceTo\)\} ₽ на человека/);
    expect(read('app/trip/[token]/_TripShareClient.tsx')).toMatch(/dayPriceLine\(day\)/);
  });
});
