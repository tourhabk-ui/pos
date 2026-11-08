/**
 * Минимум группы тура и потолок, которого не выдумывают (аудит планировщика
 * 07.11, волна 3.3, E3).
 *
 * До 07.11 `min_participants` читался и не использовался нигде: один человек
 * на туре с минимумом 4 получал день без единого слова. Пустой потолок
 * группы становился 20, а тур «без ограничения группы» делил группу на
 * машины по записанному потолку. Правила — вызовом; что движок ставит строку
 * на день — сценарий в tests/unit/planner-scenarios.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { poolQuery } = vi.hoisted(() => ({ poolQuery: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));

import { groupMinimumNote, withGroupMinimum, GROUP_MINIMUM_PREFIX } from '@/lib/planner/group-minimum';
import { capacityWarningFor, type TourDayInput, type TourDayRead } from '@/lib/planner/tour-day-reread';
import { createPlannerCache, fetchRealToursForZone } from '@/lib/planner/data';
import { applyPlanEdit, type EditablePlan, type EditDeps } from '@/lib/planner/plan-edit';
import type { DayPlan, TripRecommendation } from '@/lib/planner/engine';

beforeEach(() => { poolQuery.mockReset(); });

describe('строка «нужен набор группы»', () => {
  it('группа меньше минимума — строка с числами; дотягивает, минимума нет или он 1 — строки нет', () => {
    expect(groupMinimumNote(4, 1)).toBe('Нужен набор группы от 4 чел.: вас 1. Выезд подтверждает оператор.');
    expect(groupMinimumNote(4, 4)).toBeNull();
    expect(groupMinimumNote(4, 6)).toBeNull();
    expect(groupMinimumNote(1, 1)).toBeNull();
    expect(groupMinimumNote(null, 1)).toBeNull();
    expect(groupMinimumNote(undefined, 1)).toBeNull();
  });

  it('строки дня: прежняя снимается, новая — первой; группа дотянула — строки нет', () => {
    const old = groupMinimumNote(6, 2)!;
    expect(withGroupMinimum([old, 'Термальные: не дольше 15 минут'], 6, 3))
      .toEqual(['Нужен набор группы от 6 чел.: вас 3. Выезд подтверждает оператор.', 'Термальные: не дольше 15 минут']);
    expect(withGroupMinimum([old, 'Термальные: не дольше 15 минут'], 6, 6)).toEqual(['Термальные: не дольше 15 минут']);
    expect(withGroupMinimum(undefined, null, 2)).toEqual([]);
  });
});

describe('строка о местах не выдумывает потолок', () => {
  it('потолок записан — «из N»; группа без ограничения — без «из»', () => {
    expect(capacityWarningFor(1, 8, 2)).toBe('Свободно 1 из 8 мест, вас 2. Возможно, придётся выбрать другую дату.');
    expect(capacityWarningFor(1, null, 2)).toBe('Свободно 1 место, вас 2. Возможно, придётся выбрать другую дату.');
    expect(capacityWarningFor(3, null, 5)).toBe('Свободно 3 места, вас 5. Возможно, придётся выбрать другую дату.');
    expect(capacityWarningFor(10, null, 2)).toBeUndefined();
    expect(capacityWarningFor(2, 8, 2)).toBe('Осталось 2 места — высокий спрос');
  });

  it('группа больше потолка тура — не «другая дата», а «на одну дату не войдёт» (разбор 08.11: 24 на тур до 4)', () => {
    const line = capacityWarningFor(4, 4, 24)!;
    expect(line).toBe('На выезд тур берёт до 4 чел. (так записано у тура), вас 24: на одну дату вся группа не войдёт. '
      + 'Заявка на всю группу уйдёт оператору запросом: несколько выездов или своя группа — по договорённости с ним.');
    expect(line).not.toMatch(/другую дату/);
    // Потолок не записан — правило о потолке молчит, говорит прежнее о местах.
    expect(capacityWarningFor(4, null, 24)).toMatch(/^Свободно 4 места, вас 24/);
  });
});

describe('туры зоны: потолок и минимум — из базы, своих чисел нет', () => {
  it('группа без ограничения — потолка нет; минимум не записан — нет минимума', async () => {
    const row = (id: string, extra: Record<string, unknown>) => ({
      tour_id: id, title: id, short_description: null, nearest_free_date: null, base_price: '10000', price_unit: 'per_person',
      max_participants: 12, min_participants: 1, group_size_unlimited: false, duration_hours: 8, multi_day_count: null,
      difficulty: null, weather_dependent: false, season_start: null, season_end: null, lat: 53, lng: 158, zone: 'avachinsky',
      activity_type: 'volcano', included: null, tour_rating: null, tour_review_count: '0', operator_name: 'Оператор',
      operator_slug: 'op', operator_rating: '0', operator_review_count: '0', operator_verified: true, ...extra,
    });
    poolQuery.mockResolvedValue({ rows: [
      row('t-cap', { max_participants: 12, min_participants: 9 }),
      row('t-free', { max_participants: 12, group_size_unlimited: true, min_participants: null }),
    ] });
    const tours = (await fetchRealToursForZone('avachinsky', 'volcano', 5, createPlannerCache()))!;
    const by = new Map(tours.map((t) => [t.tourId, t]));
    expect(by.get('t-cap')).toMatchObject({ maxParticipants: 12, minParticipants: 9 });
    expect(by.get('t-free')).toMatchObject({ maxParticipants: null, minParticipants: null });
    expect(String(poolQuery.mock.calls[0]![0])).toMatch(/group_size_unlimited/);
  });
});

describe('правка «нас трое» пересчитывает строку минимума', () => {
  const day = (n: number, type: DayPlan['type'], title: string, extra: Partial<DayPlan> = {}): DayPlan => ({
    day: n, type, zone: 'avachinsky', title, description: '',
    activityType: type === 'activity' ? 'volcano' : type,
    priceFrom: 0, priceTo: 0, coords: [53, 158], defaultTransport: 'jeep', allowedTransports: ['jeep'],
    difficulty: 'moderate', childFriendly: true, minChildAge: 0, dayWarnings: [], ...extra,
  });
  const plan = (): EditablePlan => ({
    params: { interests: ['volcano'], arrivalDate: '2027-07-10', departureDate: '2027-07-12', adults: 2, children: [], budgetTier: 'comfort' },
    days: [
      day(1, 'arrival', 'Прилёт'),
      day(2, 'activity', 'Мутновский вулкан', {
        realTour: {
          tourId: 't-volc', operatorName: 'Оператор', operatorSlug: 'op', operatorRating: 0, tourRating: null, reviewCount: 0,
          verified: true, maxParticipants: 8, minParticipants: 4, weatherDependent: false, durationHours: 8, priceUnit: 'per_person',
          lodgingIncluded: null,
        },
        dayWarnings: [groupMinimumNote(4, 2)!, 'Ветер на вершине'],
      }),
      day(3, 'departure', 'Отъезд'),
    ],
  });
  const reread = vi.fn(async (input: TourDayInput): Promise<TourDayRead> => ({
    availability: 'open', availableDate: input.date, slotsRemaining: 8, realPrice: 9000, priceFrom: 9000, priceTo: 10800,
  }));
  const deps = (): EditDeps => ({
    recommend: vi.fn(async () => ({ days: [], warnings: [] } as unknown as TripRecommendation)),
    reread,
    safety: { loadWarnings: async () => ({ ok: true, warnings: [] }), parkQuery: async <T,>() => ({ rows: [] as T[] }) },
    today: () => '2026-11-07',
  });

  it('трое — строка «вас 3»; четверо — строки нет; прочие строки дня на месте', async () => {
    const three = await applyPlanEdit(plan(), { kind: 'set_party', adults: 3 }, deps());
    if (!three.ok) throw new Error(three.reason);
    expect(three.plan.days[1]!.dayWarnings).toEqual(['Нужен набор группы от 4 чел.: вас 3. Выезд подтверждает оператор.', 'Ветер на вершине']);
    const four = await applyPlanEdit(plan(), { kind: 'set_party', adults: 4 }, deps());
    if (!four.ok) throw new Error(four.reason);
    expect(four.plan.days[1]!.dayWarnings).toEqual(['Ветер на вершине']);
    expect(four.plan.days[1]!.dayWarnings.some((w) => w.startsWith(GROUP_MINIMUM_PREFIX))).toBe(false);
  });
});
