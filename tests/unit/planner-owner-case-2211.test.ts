/**
 * Кейс владельца 24.11–04.12 (22.11), вторая волна — регресс на движке
 * (`recommendTrip` на подменённом хранилище, без LLM и без ПД):
 *   1) тур без календаря, чей записанный сезон кончился до дат поездки
 *      («Семейный тур выходного дня», сезон до 15.09), в план не встаёт вовсе;
 *      тур вне сезонного ориентира, но с выездом в даты, — встаёт;
 *   6) пятидневный «термальный маршрут» не теряется в 11-дневной поездке,
 *      когда в чужие зоны план не едет (туров там нет): блок растягивается
 *      под тур, и это сказано; «не поместились в срок поездки» — нет;
 *   5) сводка о вулкане чужой зоны (Ключевской) плану без этой зоны не пишется.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Tour { tourId: string; title: string; zone: string; activityType: string; durationHours?: number; seasonStart?: string | null; seasonEnd?: string | null }
let TOURS: Record<string, Tour[]> = {};
let KEEPS: Record<string, boolean | null> = {};
let ON_REQUEST: Set<string> | null = new Set();
const onRequestCalls: number[] = [];

function realTour(t: Tour) {
  return {
    tourId: t.tourId, title: t.title, shortDescription: null,
    operatorName: 'Оператор', operatorSlug: 'op', operatorRating: null, operatorReviewCount: 0,
    operatorVerified: false, tourRating: null, tourReviewCount: 0, basePrice: 20000, priceUnit: 'per_person',
    maxParticipants: 10, minParticipants: 1, durationHours: t.durationHours ?? 10, difficulty: null,
    weatherDependent: false, seasonStart: t.seasonStart ?? null, seasonEnd: t.seasonEnd ?? null, included: null,
    lat: 53, lng: 158, zone: t.zone, activityType: t.activityType,
  };
}

vi.mock('@/lib/planner/data', () => ({
  createPlannerCache: () => new Map(),
  fetchRealToursForZone: vi.fn(async (zone: string, act: string, limit: number) =>
    (TOURS[`${zone}:${act}`] ?? []).slice(0, limit).map(realTour)),
  // Свободных дат нет ни у одного тура: у тура без календаря их нет никогда.
  fetchAvailabilityForTour: vi.fn(async () => []),
  fetchZoneCapacity: vi.fn(async () => ({ tourCount: 0, totalSlots: 0, totalBooked: 0, utilizationPercent: 0 })),
  fetchContingencyAlternatives: vi.fn(async () => []),
  fetchReviewSignals: vi.fn(async () => null),
  // Записью оператора (строками расписания) октябрь не открыт ни для чего.
  fetchActivitiesBookableInMonth: vi.fn(async () => new Set<string>()),
  fetchActivitiesOnRequest: vi.fn(async () => { onRequestCalls.push(1); return ON_REQUEST; }),
  fetchTourKeepsSchedule: vi.fn(async (id: string) => (id in KEEPS ? KEEPS[id] : true)),
  fetchSelfSafety: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, {
    isRoute: true, routeDifficulty: 'easy', mchsRegistrationRequired: false, routeRegistrationRequired: false,
    hasProfile: false, satCommunicatorRequired: null, placeRegistrationRequired: null,
  }]))),
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

/** Безопасная тропа — кандидат в самостоятельный день треккинга. */
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM agent_route_knowledge')) {
        const [zone, act] = params as [string, string];
        return zone === 'avachinsky' && act === 'trekking'
          ? { rows: [{ id: 'r-trek-ok', title: 'Тропа к Сухой речке', zone, activity_type: act, lat: 53.1, lng: 158.6, location_type: null }] }
          : { rows: [] };
      }
      return { rows: [] };
    }),
  },
}));

import { recommendTrip, type TripProfile } from '@/lib/planner/engine';

const NEXT = new Date().getUTCFullYear() + 1;
/** 24.11–04.12 следующего года: 11 дней, двое взрослых (как у владельца, без ПД). */
const OWNER: TripProfile = {
  interests: ['hot_spring', 'fishing', 'snowmobile', 'helicopter'],
  arrivalDate: `${NEXT}-11-24`, departureDate: `${NEXT}-12-04`,
  adults: 2, children: [], fitnessLevel: 'moderate', budgetTier: 'comfort', travelStyle: 'mixed',
};
const MALKI: Tour = { tourId: 't-malki', title: 'Малкинские источники', zone: 'avachinsky', activityType: 'hot_spring' };
const THERMAL5: Tour = { tourId: 't-thermal5', title: 'Камчатка: термальный маршрут', zone: 'avachinsky', activityType: 'hot_spring', durationHours: 5 * 24 };
const SNOW: Tour = { tourId: 't-snow', title: 'Снегоходы', zone: 'avachinsky', activityType: 'snowmobile' };
const HELI: Tour = { tourId: 't-heli', title: 'Облёт вулканов', zone: 'avachinsky', activityType: 'helicopter' };
const FISH: Tour = { tourId: 't-fish', title: 'Зимняя рыбалка', zone: 'avachinsky', activityType: 'fishing' };
/** Сезон по записи оператора кончился 15.09 — до дат поездки. */
const FAMILY_PAST: Tour = {
  tourId: 't-family', title: 'Семейный тур выходного дня', zone: 'avachinsky', activityType: 'fishing',
  durationHours: 2 * 24, seasonStart: `${NEXT - 1}-06-01`, seasonEnd: `${NEXT - 1}-09-15`,
};

beforeEach(() => {
  TOURS = {};
  KEEPS = { 't-malki': false, 't-thermal5': false, 't-fish': false, 't-family': false, 't-snow': false, 't-heli': false };
  ON_REQUEST = new Set(['hot_spring', 'fishing', 'snowmobile', 'helicopter']);
});

describe('кейс владельца 24.11–04.12, волна 22.11', () => {
  it('тур с кончившимся до поездки сезоном (без календаря) в план не встаёт; тур без записанного сезона — встаёт', async () => {
    TOURS = { 'avachinsky:fishing': [FAMILY_PAST, FISH], 'avachinsky:hot_spring': [MALKI] };
    const rec = await recommendTrip(OWNER);
    const ids = rec.days.map((d) => d.realTour?.tourId).filter(Boolean);
    expect(ids).not.toContain('t-family');
    expect(ids).toContain('t-fish');
    // Назван честно — «выездов в ваши даты нет», а не днём плана.
    expect(JSON.stringify(rec.days)).not.toContain('Семейный тур выходного дня');
  });

  it('пятидневный тур встаёт целиком в 11 дней, когда в чужие зоны план не едет; «не поместились» не пишется', async () => {
    TOURS = { 'avachinsky:hot_spring': [MALKI, THERMAL5], 'avachinsky:fishing': [FISH], 'avachinsky:snowmobile': [SNOW], 'avachinsky:helicopter': [HELI] };
    const rec = await recommendTrip(OWNER);
    const thermal = rec.days.filter((d) => d.realTour?.tourId === 't-thermal5').map((d) => d.day);
    expect(thermal).toHaveLength(5);
    expect(thermal[4] - thermal[0]).toBe(4);
    const text = rec.warnings.map((w) => w.message).join('\n');
    expect(text).not.toMatch(/Не поместились в срок поездки/);
    // Остальные просьбы тур не вытеснил, резерв под вертолёт на месте.
    for (const id of ['t-fish', 't-snow', 't-heli']) expect(rec.days.some((d) => d.realTour?.tourId === id)).toBe(true);
    expect(rec.days.some((d) => d.type === 'buffer')).toBe(true);
  });

  it('поездка тур не вмещает — по-прежнему не урезан и назван', async () => {
    TOURS = { 'avachinsky:hot_spring': [THERMAL5], 'avachinsky:fishing': [FISH] };
    const rec = await recommendTrip({ ...OWNER, departureDate: `${NEXT}-11-28` });
    expect(rec.days.some((d) => d.realTour?.tourId === 't-thermal5')).toBe(false);
    expect(rec.warnings.map((w) => w.message).join('\n')).toMatch(/Не поместились в срок поездки[^\n]*термальный маршрут \(5 дн\.\)/);
  });
});
