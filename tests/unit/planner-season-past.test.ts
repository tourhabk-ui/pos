/**
 * Планер: тур без календаря, записанный сезон которого кончился (#3347, 14.11).
 *
 * Такой тур принимает заявку на любую дату (правило 08.10) и встаёт в план.
 * День плана обязан сказать, что о следующем сезоне в данных нет ни слова:
 * иначе «тур 20 июля» читается как обещание, которого оператор не давал.
 * Вызовом настоящего `recommendTrip` на подменённом хранилище.
 *
 * Правило строки и форма заявки — tests/unit/tour-season-past.test.tsx.
 * Даты — относительно сегодняшнего дня.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Tour {
  tourId: string; title: string; zone: string; activityType: string;
  seasonStart: string | null; seasonEnd: string | null;
}
let TOURS: Record<string, Tour[]> = {};
/** Туры без календаря: дату подтверждает оператор. */
let NO_CALENDAR = new Set<string>();

function realTour(t: Tour) {
  return {
    tourId: t.tourId, title: t.title, shortDescription: null,
    operatorName: 'Оператор', operatorSlug: 'op', operatorRating: 0, operatorReviewCount: 0,
    operatorVerified: true, tourRating: null, tourReviewCount: 0, basePrice: 10000, priceUnit: 'per_person',
    maxParticipants: 10, minParticipants: 1,
    durationHours: 10, multiDayCount: null, difficulty: null,
    weatherDependent: false, seasonStart: t.seasonStart, seasonEnd: t.seasonEnd, included: null,
    lat: 53, lng: 158, zone: t.zone, activityType: t.activityType,
  };
}

vi.mock('@/lib/planner/data', () => ({
  createPlannerCache: () => new Map(),
  fetchRealToursForZone: vi.fn(async (zone: string, act: string, limit: number) =>
    (TOURS[`${zone}:${act}`] ?? []).slice(0, limit).map(realTour)),
  fetchAvailabilityForTour: vi.fn(async (tourId: string, from: string, to: string) => {
    if (NO_CALENDAR.has(tourId)) return [];
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
  fetchTourKeepsSchedule: vi.fn(async (id: string) => !NO_CALENDAR.has(id)),
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

const YEAR = new Date().getUTCFullYear();
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const ARRIVAL = `${YEAR + 1}-07-10`;
const trip = (): TripProfile => ({
  interests: ['trekking'], arrivalDate: ARRIVAL, departureDate: addDays(ARRIVAL, 6),
  adults: 2, children: [], fitnessLevel: 'moderate', budgetTier: 'comfort', travelStyle: 'operator',
});
const TREK = (season: Pick<Tour, 'seasonStart' | 'seasonEnd'>): Tour => ({
  tourId: 't-trek', title: 'Тропа за день', zone: 'avachinsky', activityType: 'trekking', ...season,
});
const LAST_YEAR = { seasonStart: `${YEAR - 1}-06-01`, seasonEnd: `${YEAR - 1}-09-15` };
const NOTE = `Записанный сезон этого тура закончился 15 сентября ${YEAR - 1}. Сезон следующего года оператор не объявил — возьмёт ли он на вашу дату, скажет он сам.`;

async function tourDay(tour: Tour, noCalendar: boolean) {
  TOURS = { 'avachinsky:trekking': [tour] };
  NO_CALENDAR = new Set(noCalendar ? [tour.tourId] : []);
  const rec = await recommendTrip(trip());
  const day = rec.days.find((d) => d.realTour?.tourId === tour.tourId);
  expect(day, 'тур должен встать в план: правило 08.10 дату не запрещает').toBeTruthy();
  return day!;
}

beforeEach(() => { TOURS = {}; NO_CALENDAR = new Set(); });

describe('день плана с туром, чей записанный сезон кончился', () => {
  it('календаря нет, сезон записан на прошлый год — день говорит, что следующего сезона в данных нет', async () => {
    const day = await tourDay(TREK(LAST_YEAR), true);
    expect(day.dayWarnings).toContain(NOTE);
    expect(day.dayWarnings!.filter((w) => w === NOTE)).toHaveLength(1);
  });

  it('у тура календарь — его даты называет оператор, строки о сезоне нет', async () => {
    const day = await tourDay(TREK(LAST_YEAR), false);
    expect(day.dayWarnings ?? []).not.toContain(NOTE);
    expect((day.dayWarnings ?? []).join(' ')).not.toContain('оператор не объявил');
  });

  it('сезон записан на год поездки — действует окно, строки нет', async () => {
    const day = await tourDay(TREK({ seasonStart: `${YEAR + 1}-06-01`, seasonEnd: `${YEAR + 1}-09-30` }), true);
    expect((day.dayWarnings ?? []).join(' ')).not.toContain('оператор не объявил');
  });

  it('сезон не записан вовсе — сказать о нём нечего, строки нет', async () => {
    const day = await tourDay(TREK({ seasonStart: null, seasonEnd: null }), true);
    expect((day.dayWarnings ?? []).join(' ')).not.toContain('оператор не объявил');
  });
});
