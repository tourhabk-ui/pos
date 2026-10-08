/**
 * Правка плана поездки (#2224): «добавь день рыбалки», «убери день»,
 * «переставь», «жильё подешевле» — поверх готового плана, а не пересборкой.
 *
 * Сторож держит поведением, на настоящем `recommendTrip` с подменённым
 * хранилищем: сценарий из задачи «план → добавь день рыбалки → замени жильё»
 * даёт три согласованных плана, и дни, которых правка не касалась, остаются
 * теми же. Невозможная правка — отказ с причиной, а не план с нуля.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Tour { tourId: string; title: string; zone: string; activityType: string }
let TOURS: Record<string, Tour[]> = {};

vi.mock('@/lib/planner/data', () => ({
  createPlannerCache: () => new Map(),
  fetchRealToursForZone: vi.fn(async (zone: string, act: string, limit: number) =>
    (TOURS[`${zone}:${act}`] ?? []).slice(0, limit).map((t) => ({
      tourId: t.tourId, title: t.title, shortDescription: null,
      operatorName: 'Оператор', operatorSlug: 'op', operatorRating: 4.5, operatorReviewCount: 3,
      operatorVerified: true, tourRating: null, tourReviewCount: 0, basePrice: 10000, priceUnit: 'per_person',
      maxParticipants: 10, minParticipants: 1, durationHours: 8, difficulty: null,
      weatherDependent: false, seasonStart: null, seasonEnd: null, included: null,
      lat: 53, lng: 158, zone: t.zone, activityType: t.activityType,
    }))),
  fetchAvailabilityForTour: vi.fn(async (_id: string, from: string) =>
    [{ date: from, availableSlots: 10, bookedSlots: 0, remaining: 10, priceOverride: null }]),
  fetchZoneCapacity: vi.fn(async () => ({ tourCount: 0, totalSlots: 0, totalBooked: 0, utilizationPercent: 0 })),
  fetchContingencyAlternatives: vi.fn(async () => []),
  fetchReviewSignals: vi.fn(async () => null),
  fetchActivitiesBookableInMonth: vi.fn(async () => new Set<string>()),
  fetchActivitiesOnRequest: vi.fn(async () => new Set<string>()),
  fetchSelfSafety: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/planner/place-load', () => ({
  fetchCandidateLoads: vi.fn(async () => new Map()),
  fetchTourLoads: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/planner/intelligence', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/planner/intelligence')>();
  return { ...real, fetchForecastDays: vi.fn(async () => ({ ok: false, reason: 'test' })) };
});
vi.mock('@/lib/ai/providers', () => ({ callAIWithModelDirect: vi.fn(async () => '') }));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => null }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { recommendTrip, type DayPlan } from '@/lib/planner/engine';
import { applyPlanEdit, planPrice, planProfile, type EditablePlan, type PlanParams } from '@/lib/planner/plan-edit';

const PARAMS: PlanParams = {
  interests: ['volcano', 'bears'],
  arrivalDate: '2027-07-10', departureDate: '2027-07-16',
  adults: 2, children: [], budgetTier: 'comfort',
};

async function freshPlan(): Promise<EditablePlan> {
  const rec = await recommendTrip(planProfile(PARAMS), { itinerary: 'plain' });
  return { params: { ...PARAMS, interests: [...PARAMS.interests] }, days: rec.days };
}

/** Отпечаток дня без номера — чтобы видеть «тот же день», даже если номер сдвинулся. */
const print = (d: DayPlan) => `${d.type}|${d.zone}|${d.title}|${d.realTour?.tourId ?? '-'}`;

beforeEach(() => {
  TOURS = {
    'avachinsky:volcano': [{ tourId: 't-volc', title: 'Восхождение на Авачинский', zone: 'avachinsky', activityType: 'volcano' }],
    'avachinsky:fishing': [{ tourId: 't-fish', title: 'Рыбалка на Авче', zone: 'avachinsky', activityType: 'fishing' }],
  };
});

describe('сценарий из задачи: план → добавь день рыбалки → замени жильё', () => {
  it('три согласованных плана, нетронутые дни не меняются', async () => {
    const p1 = await freshPlan();
    const before = p1.days.filter((d) => d.type !== 'departure').map(print);

    const r2 = await applyPlanEdit(p1, { kind: 'add_day', interest: 'fishing' });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    const p2 = r2.plan;
    // Поездка на день длиннее, новый день — рыбалка, перед отъездом.
    expect(p2.params.departureDate).toBe('2027-07-17');
    const fishing = p2.days.filter((d) => d.activityType === 'fishing');
    expect(fishing).toHaveLength(1);
    expect(fishing[0].realTour?.tourId).toBe('t-fish');
    const dep2 = p2.days.find((d) => d.type === 'departure');
    expect(dep2?.day).toBe(fishing[0].day + 1);
    // Всё, что было до отъезда, — те же дни на тех же местах.
    expect(p2.days.filter((d) => d.type !== 'departure' && d.activityType !== 'fishing').map(print)).toEqual(before);
    expect(p2.days.filter((d) => d.type !== 'departure' && d.activityType !== 'fishing').map((d) => d.day))
      .toEqual(p1.days.filter((d) => d.type !== 'departure').map((d) => d.day));
    expect(p2.params.interests).toContain('fishing');

    const r3 = await applyPlanEdit(p2, { kind: 'set_lodging', tier: 'economy' });
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    const p3 = r3.plan;
    // Дни те же целиком, поменялась только оценка жилья.
    expect(p3.days).toEqual(p2.days);
    expect(planPrice(p3).accommodation[0]).toBeLessThan(planPrice(p2).accommodation[0]);
    expect(planPrice(p3).activities).toEqual(planPrice(p2).activities);
    // Правка не мутирует прежний план.
    expect(p2.params.budgetTier).toBe('comfort');
  });
});

describe('убрать и переставить', () => {
  it('убрать день: поездка короче, дни после — на место раньше, прочие не тронуты', async () => {
    const p = await freshPlan();
    const victim = p.days.find((d) => d.type === 'activity');
    expect(victim).toBeTruthy();
    if (!victim) return;
    const r = await applyPlanEdit(p, { kind: 'remove_day', day: victim.day });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.params.departureDate).toBe('2027-07-15');
    expect(r.plan.days.map(print)).toEqual(p.days.filter((d) => d !== victim).map(print));
    expect(r.plan.days.filter((d) => d.day < victim.day).map((d) => d.day))
      .toEqual(p.days.filter((d) => d.day < victim.day).map((d) => d.day));
  });

  it('прилёт, отъезд и несуществующий день не убираются — отказ с причиной', async () => {
    const p = await freshPlan();
    const arr = await applyPlanEdit(p, { kind: 'remove_day', day: 1 });
    expect(arr).toEqual({ ok: false, reason: expect.stringMatching(/день прилёта/) });
    const none = await applyPlanEdit(p, { kind: 'remove_day', day: 40 });
    expect(none).toEqual({ ok: false, reason: expect.stringMatching(/Дня 40 в плане нет/) });
  });

  it('переставить день внутри зоны: меняется только отрезок между местами', async () => {
    const p = await freshPlan();
    const movable = p.days.filter((d) => d.type === 'activity' || d.type === 'rest');
    expect(movable.length).toBeGreaterThanOrEqual(2);
    const [a, b] = [movable[0], movable[movable.length - 1]];
    const r = await applyPlanEdit(p, { kind: 'move_day', day: b.day, to: a.day });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.days.find((d) => d.day === a.day)?.title).toBe(b.title);
    // Вне отрезка — как было.
    const outside = (ds: DayPlan[]) => ds.filter((d) => d.day < a.day || d.day > b.day).map((d) => `${d.day}|${print(d)}`);
    expect(outside(r.plan.days)).toEqual(outside(p.days));
    expect(r.plan.days).toHaveLength(p.days.length);
  });

  it('прилёт не переставляется', async () => {
    const p = await freshPlan();
    const r = await applyPlanEdit(p, { kind: 'move_day', day: 1, to: 3 });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/день прилёта/) });
  });
});

describe('добавить день — только то, что движок подобрал', () => {
  it('занятие не по возрасту младшего не добавляется', async () => {
    const p = await freshPlan();
    const r = await applyPlanEdit({ ...p, params: { ...p.params, children: [6] } }, { kind: 'add_day', interest: 'volcano' });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/с 12 лет, младшему 6/) });
  });

  it('движок дня не подобрал — отказ, а не придуманный день', async () => {
    const p = await freshPlan();
    const r = await applyPlanEdit(p, { kind: 'add_day', interest: 'fishing' }, {
      recommend: async () => ({ zones: [], days: [], warnings: [], priceBreakdown: planPrice(p), itinerary: '', catalogueOpen: null }),
    });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/не собрался.*Придумывать день не стали/) });
  });

  it('неизвестный интерес — отказ', async () => {
    const p = await freshPlan();
    expect(await applyPlanEdit(p, { kind: 'add_day', interest: 'skydiving' })).toEqual({ ok: false, reason: expect.stringMatching(/не знает/) });
  });
});
