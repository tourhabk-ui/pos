/**
 * Места и цена тура дня после правки плана (аудит планировщика 07.11, M3) —
 * то же правило, что у движка при сборке дня.
 *
 * `rereadTourDay` читает занятость на дату дня и цену по правилу брони для
 * группы. Правило не своё: сторож собирает план настоящим `recommendTrip` и
 * перечитывает тот же тур на ту же дату той же группой — поля дня совпадают.
 * Разойдутся (движок поменяет текст о местах, запас цены, исход «цены нет»)
 * — сторож красный, а не правка плана тихо говорит другое.
 *
 * Исходы, которых у движка при сборке нет: тур сняли с витрины после сборки
 * плана и не смогли прочитать тур — свои слова, а не «проверить не удалось»
 * вместо «тура нет».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Tier { min_people: number; max_people: number | null; price_per_person: string }
let TIERS: Tier[] = [];
let TOUR_ROW: Record<string, unknown> | null = null;
let TOUR_ROW_FAILS = false;
let SLOT_REMAINING = 2;
let SLOTS_FAIL = false;
let SLOT_DATES: string[] | null = null;
/** Ведёт ли тур календарь (fetchTourKeepsSchedule). */
let KEEPS = true;

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('AS on_sale')) {
        if (TOUR_ROW_FAILS) throw Object.assign(new Error('down'), { code: '57P01' });
        return { rows: TOUR_ROW ? [TOUR_ROW] : [] };
      }
      if (sql.includes('FROM tour_price_tiers')) return { rows: TIERS };
      return { rows: [] };
    }),
  },
}));

function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

vi.mock('@/lib/planner/data', () => ({
  createPlannerCache: () => new Map(),
  fetchRealToursForZone: vi.fn(async (zone: string, act: string) =>
    zone === 'avachinsky' && act === 'volcano'
      ? [{
        tourId: '49', title: 'Самые высокие вулканы Камчатки', shortDescription: null,
        operatorName: 'Край Вулканов', operatorSlug: 'volcanoesland', operatorRating: 0, operatorReviewCount: 0,
        operatorVerified: true, tourRating: null, tourReviewCount: 0, basePrice: 520000, priceUnit: 'per_person',
        maxParticipants: 15, minParticipants: 1, durationHours: 8, multiDayCount: null, difficulty: null,
        weatherDependent: false, seasonStart: null, seasonEnd: null, included: null,
        lat: 53, lng: 158, zone: 'avachinsky', activityType: 'volcano',
      }]
      : []),
  fetchAvailabilityForTour: vi.fn(async (_id: string, from: string, to: string) => {
    if (SLOTS_FAIL) throw new Error('Не удалось проверить занятость тура — попробуйте позже.');
    return datesBetween(from, to)
      .filter((date) => SLOT_DATES === null || SLOT_DATES.includes(date))
      .map((date) => ({ date, availableSlots: 15, bookedSlots: 15 - SLOT_REMAINING, remaining: SLOT_REMAINING, priceOverride: null }));
  }),
  fetchZoneCapacity: vi.fn(async () => ({ tourCount: 0, totalSlots: 0, totalBooked: 0, utilizationPercent: 0 })),
  fetchContingencyAlternatives: vi.fn(async () => []),
  fetchReviewSignals: vi.fn(async () => null),
  fetchActivitiesBookableInMonth: vi.fn(async () => new Set<string>()),
  fetchActivitiesOnRequest: vi.fn(async () => new Set<string>()),
  fetchTourKeepsSchedule: vi.fn(async () => KEEPS),
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

import { recommendTrip, type DayPlan, type TripProfile } from '@/lib/planner/engine';
import { dateOfTripDay } from '@/lib/planner/flow-balance';
import { rereadTourDay, TOUR_OFF_SALE_TEXT, type TourDayRead } from '@/lib/planner/tour-day-reread';
import { PRICE_UNREAD_TEXT } from '@/lib/planner/tour-price';
import { PRICE_TIER_MISS_TEXT } from '@/lib/tours/price-tiers';

const ROW = { base_price: '520000', price_unit: 'per_person', multi_day_count: null, duration_hours: '8', on_sale: true };
const PROFILE: TripProfile = {
  interests: ['volcano'], arrivalDate: '2027-07-10', departureDate: '2027-07-14',
  adults: 2, children: [], fitnessLevel: 'moderate', budgetTier: 'comfort', tripOrigin: 'local',
};

/** Поля дня, которые зависят от даты и группы, — как их видит смета и текст плана. */
function fields(d: DayPlan | TourDayRead & { priceLabel?: string }): Record<string, unknown> {
  const label = 'realTour' in d ? (d as DayPlan).realTour?.priceLabel : (d as TourDayRead).priceLabel;
  return {
    availability: d.availability, availableDate: d.availableDate, slotsRemaining: d.slotsRemaining,
    capacityWarning: d.capacityWarning, realPrice: d.realPrice, priceMissing: d.priceMissing,
    priceFrom: d.priceFrom, priceTo: d.priceTo, priceLabel: label,
  };
}

async function engineDay(adults: number): Promise<{ day: DayPlan; date: string }> {
  const rec = await recommendTrip({ ...PROFILE, adults }, { itinerary: 'plain' });
  const day = rec.days.find((d) => d.realTour?.tourId === '49');
  if (!day) throw new Error('тур 49 не попал в план — сверять нечего');
  return { day, date: dateOfTripDay(PROFILE.arrivalDate!, day.day)! };
}

beforeEach(() => {
  TIERS = [];
  TOUR_ROW = ROW;
  TOUR_ROW_FAILS = false;
  SLOT_REMAINING = 2;
  SLOTS_FAIL = false;
  SLOT_DATES = null;
  KEEPS = true;
});

describe('то же правило, что у движка: поля дня совпадают', () => {
  it('мест меньше, чем людей: та же строка о местах, та же цена и запас', async () => {
    const { day, date } = await engineDay(3);
    expect(day.capacityWarning).toContain('вас 3');
    const r = await rereadTourDay({ tourId: '49', maxParticipants: 15, date, participants: 3 });
    expect(fields(r)).toEqual(fields(day));
    expect(r.realPrice).toBe(520000);
  });

  it('мест ровно столько, сколько людей, и не больше трёх: «высокий спрос» — тем же текстом', async () => {
    SLOT_REMAINING = 3;
    const { day, date } = await engineDay(3);
    expect(day.capacityWarning).toMatch(/высокий спрос/);
    const r = await rereadTourDay({ tourId: '49', maxParticipants: 15, date, participants: 3 });
    expect(fields(r)).toEqual(fields(day));
  });

  it('группа вне ступеней цены: цены нет у обоих, причина одна', async () => {
    TIERS = [{ min_people: 6, max_people: 8, price_per_person: '520000' }];
    SLOT_REMAINING = 10;
    const { day, date } = await engineDay(2);
    expect(day.priceMissing).toBe(PRICE_TIER_MISS_TEXT(2));
    const r = await rereadTourDay({ tourId: '49', maxParticipants: 15, date, participants: 2 });
    expect(fields(r)).toEqual(fields(day));
  });

  it('свободных дат нет: «мест нет» у обоих, без даты и остатка', async () => {
    // Тур без календаря: дату подтверждает оператор, и движок ставит его в
    // план без мест на дату (тур с календарём без выезда в этот день движок
    // в план не ставит вовсе — сверять было бы нечего).
    SLOT_DATES = [];
    KEEPS = false;
    const { day, date } = await engineDay(2);
    expect(day.availability).toBe('none');
    const r = await rereadTourDay({ tourId: '49', maxParticipants: 15, date, participants: 2 });
    expect(fields(r)).toEqual(fields(day));
  });
});

describe('свои исходы перечитывания', () => {
  it('занятость не прочиталась — «не прочитали», а не «мест нет»; цена посчитана', async () => {
    SLOTS_FAIL = true;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await rereadTourDay({ tourId: '49', maxParticipants: 15, date: '2027-07-11', participants: 2 });
    expect(r.availability).toBe('unread');
    expect(r.availableDate).toBeUndefined();
    expect(r.slotsRemaining).toBeUndefined();
    expect(r.realPrice).toBe(520000);
    expect(log).toHaveBeenCalledWith('[planner] занятость тура для правки плана не прочитана', expect.objectContaining({ tourId: '49' }));
    log.mockRestore();
  });

  it('тур сняли с витрины или его нет — цены нет, и сказано почему; запас цены не выдуман', async () => {
    TOUR_ROW = { ...ROW, on_sale: false };
    const off = await rereadTourDay({ tourId: '49', maxParticipants: 15, date: '2027-07-11', participants: 2 });
    expect(off.priceMissing).toBe(TOUR_OFF_SALE_TEXT);
    expect([off.realPrice, off.priceFrom, off.priceTo]).toEqual([undefined, 0, 0]);
    TOUR_ROW = null;
    expect((await rereadTourDay({ tourId: '49', maxParticipants: 15, date: '2027-07-11', participants: 2 })).priceMissing).toBe(TOUR_OFF_SALE_TEXT);
  });

  it('тур не прочитался — «проверить не удалось» и строка в лог с SQLSTATE', async () => {
    TOUR_ROW_FAILS = true;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await rereadTourDay({ tourId: '49', maxParticipants: 15, date: '2027-07-11', participants: 2 });
    expect(r.priceMissing).toBe(PRICE_UNREAD_TEXT);
    expect(r.availability).toBe('open');
    expect(log).toHaveBeenCalledWith('[planner] тур дня для правки плана не прочитан', expect.objectContaining({ tourId: '49', sqlstate: '57P01' }));
    log.mockRestore();
  });
});
