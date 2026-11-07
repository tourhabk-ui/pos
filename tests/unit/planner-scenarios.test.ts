/**
 * Сценарии планировщика на подменённом хранилище (аудит планировщика 07.11).
 *
 * Настоящий recommendTrip, туры и маршруты — из подмены, без сети, базы и
 * моделей. Файл растёт вместе с волнами аудита (раздел 5, волна 5): каждый
 * сценарий держит инвариант плана, а не текст исходника.
 *
 * Даты — июль следующего года от сегодняшнего дня: вулканы в сезоне, а тест
 * с зашитой датой — бомба.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Tour {
  tourId: string; title: string; durationHours: number | null; zone: string; activityType: string;
  basePrice?: number;
}
/** Туры по паре «зона:активность» — свои в каждом сценарии. */
let TOURS: Record<string, Tour[]> = {};

function realTour(t: Tour) {
  return {
    tourId: t.tourId, title: t.title, shortDescription: null,
    operatorName: 'Оператор', operatorSlug: 'op', operatorRating: 0, operatorReviewCount: 0,
    operatorVerified: true, tourRating: null, tourReviewCount: 0, basePrice: t.basePrice ?? 10000, priceUnit: 'per_person',
    maxParticipants: 10, minParticipants: 1, durationHours: t.durationHours, multiDayCount: null, difficulty: null,
    weatherDependent: false, seasonStart: null, seasonEnd: null, included: null,
    lat: 53, lng: 158, zone: t.zone, activityType: t.activityType,
  };
}

vi.mock('@/lib/planner/data', () => ({
  createPlannerCache: () => new Map(),
  fetchRealToursForZone: vi.fn(async (zone: string, act: string, limit: number) =>
    (TOURS[`${zone}:${act}`] ?? []).slice(0, limit).map(realTour)),
  // Места есть на каждый день окна: сценарии здесь — про дни, не про места.
  fetchAvailabilityForTour: vi.fn(async (_tourId: string, from: string, to: string) => {
    const out = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
      out.push({ date: new Date(t).toISOString().slice(0, 10), availableSlots: 10, bookedSlots: 0, remaining: 10, priceOverride: null });
    }
    return out;
  }),
  fetchZoneCapacity: vi.fn(async () => ({ tourCount: 0, totalSlots: 0, totalBooked: 0, utilizationPercent: null })),
  fetchContingencyAlternatives: vi.fn(async () => []),
  fetchReviewSignals: vi.fn(async () => null),
  fetchActivitiesBookableInMonth: vi.fn(async () => new Set<string>()),
  fetchActivitiesOnRequest: vi.fn(async () => new Set<string>()),
  fetchTourKeepsSchedule: vi.fn(async () => true),
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

import { recommendTrip, type TripProfile } from '@/lib/planner/engine';
import { tourPlanSpan } from '@/lib/planner/tour-span';

const NEXT_JULY = new Date().getUTCFullYear() + 1;
const profile = (days: number, interests: string[]): TripProfile => ({
  interests,
  arrivalDate: `${NEXT_JULY}-07-10`,
  departureDate: new Date(Date.parse(`${NEXT_JULY}-07-10T00:00:00Z`) + (days - 1) * 86_400_000).toISOString().slice(0, 10),
  adults: 2,
  children: [],
  fitnessLevel: 'moderate',
  budgetTier: 'comfort',
});

/** Сколько дней плана занимает каждый поставленный тур. */
function daysByTour(rec: Awaited<ReturnType<typeof recommendTrip>>): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of rec.days) {
    const id = d.realTour?.tourId;
    if (id) out.set(String(id), (out.get(String(id)) ?? 0) + 1);
  }
  return out;
}

beforeEach(() => { TOURS = {}; });

describe('E1: многодневный тур не режется на краю блока (волна 3.1)', () => {
  // Проба 6.4 C аудита: 7 дней, вулканы, туры на 1, 2 и 3 дня. До 3.1 тур
  // на три дня вставал днём 5, «день 2 из 3» — днём 6, третьего дня не было,
  // а цена в смете оставалась полной: проверка длины сравнивала тур с блоком
  // целиком, а не с остатком.
  const ONE: Tour = { tourId: 't-1', title: 'Вулкан за день', durationHours: 10, zone: 'avachinsky', activityType: 'volcano' };
  const TWO: Tour = { tourId: 't-2', title: 'Два вулкана', durationHours: 48, zone: 'avachinsky', activityType: 'volcano' };
  const THREE: Tour = { tourId: 't-3', title: 'Три вулкана', durationHours: 72, zone: 'avachinsky', activityType: 'volcano' };

  it('каждый поставленный тур — всеми своими днями; не вошедший — назван', async () => {
    TOURS['avachinsky:volcano'] = [ONE, TWO, THREE];
    const rec = await recommendTrip(profile(7, ['volcano']));
    const placed = daysByTour(rec);
    for (const t of [ONE, TWO, THREE]) {
      const span = tourPlanSpan(t.durationHours, null) ?? 1;
      const n = placed.get(t.tourId) ?? 0;
      expect([0, span], `${t.title}: в плане ${n} дн. из ${span}`).toContain(n);
    }
    // «Состав N туров не заполнен» считает туры, а не их дни.
    const lodging = rec.warnings.find((w) => w.message.startsWith('Состав '));
    const n = placed.size;
    expect(lodging?.message).toContain(n === 1 ? 'Состав одного тура' : `Состав ${n} туров`);
    expect(lodging?.message).toContain('итог в смете завышен');
    expect(lodging?.severity).toBe('important');
    // Не вошедший многодневный тур назван словами, а не пропал молча.
    const missing = [ONE, TWO, THREE].filter((t) => !placed.has(t.tourId) && (tourPlanSpan(t.durationHours, null) ?? 1) > 1);
    const text = rec.warnings.map((w) => w.message).join('\n');
    for (const t of missing) expect(text).toContain(t.title);
  });

  it('вилка активностей — ровно по поставленным турам: цена тура без его дней не считается', async () => {
    TOURS['avachinsky:volcano'] = [ONE, TWO, THREE];
    const rec = await recommendTrip(profile(7, ['volcano']));
    const placedTours = daysByTour(rec).size;
    // У каждого тура цена 10 000 ₽ за человека; верх вилки — с запасом движка.
    expect(rec.priceBreakdown.activities[0]).toBe(placedTours * 10000);
  });
});
