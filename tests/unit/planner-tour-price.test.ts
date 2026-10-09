/**
 * Сторож: цена тура в плане — по правилу брони (#2304, lib/planner/tour-price).
 *
 * У одиннадцати туров «Края Вулканов» есть ступени цены по размеру группы
 * (миграция 1176), и нижняя у большинства — от шести человек. Бронь паре
 * туристов отвечает «цену называет оператор», а план показывал заголовочную
 * цену, умноженную на двоих. Группе от девяти бронь даёт цену ступени, план —
 * заголовочную.
 *
 * Сторож держит поведением, на настоящем `recommendTrip` и настоящем
 * `honestTourPrice` с подменённой базой:
 *   — группа вне ступеней: у дня нет цены, есть причина, и в смету тур идёт
 *     строкой «цену называет оператор», а не суммой;
 *   — группа внутри ступени: цена ступени, а не заголовочная;
 *   — база не ответила: цены нет, причина другая, отказ в логе (§4.0);
 *   — ступеней нет: цена тура как была.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Tier { min_people: number; max_people: number | null; price_per_person: string }
let TIERS: Tier[] = [];
let FAIL_PRICING = false;
const queries: string[] = [];

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (FAIL_PRICING && (sql.includes('tour_price_tiers') || sql.includes('tour_pricing_rules'))) {
        throw Object.assign(new Error('down'), { code: '57P01' });
      }
      if (sql.includes('FROM tour_price_tiers')) return { rows: TIERS };
      return { rows: [] };
    }),
  },
}));

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
  fetchAvailabilityForTour: vi.fn(async () => []),
  fetchZoneCapacity: vi.fn(async () => ({ tourCount: 0, totalSlots: 0, totalBooked: 0, utilizationPercent: 0 })),
  fetchContingencyAlternatives: vi.fn(async () => []),
  fetchReviewSignals: vi.fn(async () => null),
  fetchActivitiesBookableInMonth: vi.fn(async () => new Set<string>()),
  fetchActivitiesOnRequest: vi.fn(async () => new Set<string>()),
  fetchTourKeepsSchedule: vi.fn(async () => false),
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

import { planTourPrice, PRICE_UNREAD_TEXT } from '@/lib/planner/tour-price';
import { recommendTrip, type TripProfile } from '@/lib/planner/engine';
import { estimateGroup, calculatePriceBreakdown } from '@/lib/planner/estimate';
import { PRICE_TIER_MISS_TEXT } from '@/lib/tours/price-tiers';

// Ступени тура 49 из миграции 1176: 6–8 → 520 000, от 9 → 410 000.
const KRAI_TIERS: Tier[] = [
  { min_people: 6, max_people: 8, price_per_person: '520000' },
  { min_people: 9, max_people: null, price_per_person: '410000' },
];

const input = (participants: number, tourDate: string | null = '2027-07-12') => ({
  tourId: '49', basePrice: 520000, priceUnit: 'per_person', participants,
  multiDayCount: null, durationHours: 8, tourDate,
});

beforeEach(() => {
  TIERS = [];
  FAIL_PRICING = false;
  queries.length = 0;
});

describe('planTourPrice — та же цена, что у брони', () => {
  it('ступеней нет — цена тура', async () => {
    expect(await planTourPrice(input(2))).toEqual({ kind: 'priced', unitPrice: 520000, label: null });
  });

  it('группа вне ступеней — цены нет, и сказано, кто её назовёт', async () => {
    TIERS = KRAI_TIERS;
    expect(await planTourPrice(input(2))).toEqual({ kind: 'missing', text: PRICE_TIER_MISS_TEXT(2) });
  });

  it('группа внутри ступени — цена ступени, а не заголовочная', async () => {
    TIERS = KRAI_TIERS;
    expect(await planTourPrice(input(10))).toEqual({ kind: 'priced', unitPrice: 410000, label: null });
  });

  it('без даты — только ступени: правила на дату не читаются', async () => {
    TIERS = KRAI_TIERS;
    expect(await planTourPrice(input(10, null))).toMatchObject({ kind: 'priced', unitPrice: 410000 });
    expect(queries.some((q) => q.includes('tour_pricing_rules'))).toBe(false);
  });

  it('база не ответила — цены нет, причина своя, отказ в логе', async () => {
    FAIL_PRICING = true;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await planTourPrice(input(2))).toEqual({ kind: 'missing', text: PRICE_UNREAD_TEXT });
    expect(log).toHaveBeenCalledWith('[planner] цена тура не посчитана', expect.objectContaining({ tourId: '49', sqlstate: '57P01' }));
    log.mockRestore();
  });
});

const PROFILE: TripProfile = {
  interests: ['volcano'], arrivalDate: '2027-07-10', departureDate: '2027-07-14',
  adults: 2, children: [], fitnessLevel: 'moderate', budgetTier: 'comfort', tripOrigin: 'local',
};

describe('движок и смета: тур вне ступеней не получает выдуманную сумму', () => {
  it('двоим — «цену называет оператор»: у дня нет ни цены, ни справочной вилки', async () => {
    TIERS = KRAI_TIERS;
    const rec = await recommendTrip(PROFILE, { itinerary: 'plain' });
    const day = rec.days.find((d) => d.realTour?.tourId === '49');
    expect(day, 'тур 49 не попал в план — проверять нечего').toBeDefined();
    expect(day!.realPrice).toBeUndefined();
    expect(day!.priceMissing).toBe(PRICE_TIER_MISS_TEXT(2));
    expect([day!.priceFrom, day!.priceTo]).toEqual([0, 0]);

    const e = estimateGroup(rec.days, { adults: 2, children: [], budgetTier: 'comfort', tripOrigin: 'local' });
    const line = e.lines.find((l) => l.kind === 'tour' && l.label.includes(day!.title));
    expect(line?.total).toBeNull();
    expect(line?.note).toBe(PRICE_TIER_MISS_TEXT(2));
    expect(e.unpriced).toContain(line!.label);
    expect(e.fromTours).toEqual([0, 0]);

    const pb = calculatePriceBreakdown(rec.days, PROFILE);
    expect(pb.activityPricing.unpriced).toBe(1);
    expect(pb.activityPricing.tourPriced).toBe(0);
  });

  it('десятерым — цена ступени 410 000, и смета считает её на каждого', async () => {
    TIERS = KRAI_TIERS;
    const rec = await recommendTrip({ ...PROFILE, adults: 10 }, { itinerary: 'plain' });
    const day = rec.days.find((d) => d.realTour?.tourId === '49')!;
    expect(day.realPrice).toBe(410000);
    expect(day.priceMissing).toBeUndefined();
    const e = estimateGroup(rec.days, { adults: 10, children: [], budgetTier: 'comfort', tripOrigin: 'local' });
    expect(e.fromTours[0]).toBe(410000 * 10);
  });

  it('ступеней нет — как было: заголовочная цена', async () => {
    const rec = await recommendTrip(PROFILE, { itinerary: 'plain' });
    expect(rec.days.find((d) => d.realTour?.tourId === '49')?.realPrice).toBe(520000);
  });

  it('у дня тура — дни брони для цены «за день»', async () => {
    const rec = await recommendTrip(PROFILE, { itinerary: 'plain' });
    expect(rec.days.find((d) => d.realTour?.tourId === '49')?.realTour?.durationDays).toBe(1);
  });
});
