/**
 * Планер читает действующие предупреждения МЧС и не отдаёт день у названного
 * вулкана как обычный выход. Отказ чтения — отдельная строка, не «тихо».
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveWarning } from '@/lib/safety/mchs-bulletin';

const state: { ok: boolean; warnings: ActiveWarning[] } = { ok: true, warnings: [] };

vi.mock('@/lib/db-pool', () => ({
  pool: { query: vi.fn(async () => ({ rows: [] })) },
}));
vi.mock('@/lib/safety/active-warnings', () => ({
  loadActiveWarnings: vi.fn(async () => (
    state.ok ? { ok: true as const, warnings: state.warnings } : { ok: false as const, warnings: [] as ActiveWarning[] }
  )),
}));
vi.mock('@/lib/planner/data', () => ({
  createPlannerCache: () => new Map(),
  fetchRealToursForZone: vi.fn(async (zone: string, act: string) => (
    zone === 'avachinsky' && act === 'volcano'
      ? [{
        tourId: 'shiv', title: 'Восхождение на Шивелуч', shortDescription: 'Северная группа',
        operatorName: 'Север', operatorSlug: 'sever', operatorRating: 0, operatorReviewCount: 0,
        operatorVerified: true, tourRating: null, tourReviewCount: 0, basePrice: 10000, priceUnit: 'per_person',
        maxParticipants: 8, minParticipants: 1, durationHours: 10, multiDayCount: null, difficulty: 'hard',
        weatherDependent: true, seasonStart: null, seasonEnd: null, included: null,
        lat: 56.6, lng: 161.3, zone: 'avachinsky', activityType: 'volcano',
      }]
      : []
  )),
  fetchAvailabilityForTour: vi.fn(async () => []),
  fetchZoneCapacity: vi.fn(async () => ({ tourCount: 0, totalSlots: 0, totalBooked: 0, utilizationPercent: 0 })),
  fetchContingencyAlternatives: vi.fn(async () => []),
  fetchReviewSignals: vi.fn(async () => null),
  fetchActivitiesBookableInMonth: vi.fn(async () => new Set<string>(['volcano'])),
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
vi.mock('@/lib/ai/providers', () => ({ callAIWithModelDirect: vi.fn(async () => 'Маршрут безопасный и без риска.') }));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => 'test-model' }));

import { recommendTrip, type TripProfile } from '@/lib/planner/engine';

const PROFILE: TripProfile = {
  interests: ['volcano'],
  arrivalDate: '2026-10-24',
  departureDate: '2026-10-27',
  adults: 2,
  children: [],
  fitnessLevel: 'active',
  budgetTier: 'comfort',
  tripOrigin: 'local',
};

const SHIVELUCH: ActiveWarning = {
  kind: 'volcano',
  place: 'Шивелуч',
  stems: ['шивелуч'],
  period: '06:00 24.10–06:00 25.10',
  sourceUrl: 'https://vk.com/mchs_kamchatka',
};

beforeEach(() => {
  state.ok = true;
  state.warnings = [];
});

describe('планер и действующие предупреждения МЧС', () => {
  it('день с Шивелучем помечен, а пересказ маршрута не остаётся «без риска»', async () => {
    state.warnings = [SHIVELUCH];
    const rec = await recommendTrip(PROFILE);
    const day = rec.days.find((d) => d.title.includes('Шивелуч'));
    expect(day, 'тур на Шивелуч не попал в план').toBeDefined();
    expect(day!.dayWarnings.join('\n')).toMatch(/Шивелуч/);
    expect(day!.dayWarnings.join('\n')).toMatch(/нельзя называть безопасн/);
    expect(rec.warnings.some((w) => w.type === 'mchs' && /Шивелуч/.test(w.message))).toBe(true);
    expect(rec.itinerary).toMatch(/нельзя называть безопасн/);
  });

  it('сводка не прочиталась — план говорит об этом и не рисует спокойствие', async () => {
    state.ok = false;
    const rec = await recommendTrip(PROFILE, { itinerary: 'plain' });
    expect(rec.warnings.some((w) => /Сводки МЧС не прочитаны/.test(w.message))).toBe(true);
    expect(rec.days.every((d) => !d.dayWarnings.some((n) => /Шивелуч/.test(n)))).toBe(true);
  });
});
