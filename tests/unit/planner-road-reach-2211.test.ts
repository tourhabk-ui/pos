/**
 * Аудит дорог /planner (вопрос владельца 22.11: «а ты взял в расчёт
 * расстояние между точками, не везде есть дороги и ночёвки»). Тот же
 * recommendTrip, LLM подменён, дорожный граф подменён, моки без ПД.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Tour { tourId: string; title: string; zone: string; activityType: string; durationHours?: number; seasonStart?: string | null; seasonEnd?: string | null; lat?: number; lng?: number; coordsKnown?: boolean; included?: string[] }
let TOURS: Record<string, Tour[]> = {};
let KEEPS: Record<string, boolean | null> = {};
/** Маршруты треккинга Авачинской зоны в тесте; null — одна ближняя тропа. */
let TREK_ROUTES: Array<Record<string, unknown>> | null = null;
let ON_REQUEST: Set<string> | null = new Set();
const onRequestCalls: number[] = [];

function realTour(t: Tour) {
  return {
    tourId: t.tourId, title: t.title, shortDescription: null,
    operatorName: 'Оператор', operatorSlug: 'op', operatorRating: null, operatorReviewCount: 0,
    operatorVerified: false, tourRating: null, tourReviewCount: 0, basePrice: 20000, priceUnit: 'per_person',
    maxParticipants: 10, minParticipants: 1, durationHours: t.durationHours ?? 10, difficulty: null,
    weatherDependent: false, seasonStart: t.seasonStart ?? null, seasonEnd: t.seasonEnd ?? null, included: t.included ?? null,
    lat: t.lat ?? 53, lng: t.lng ?? 158, coordsKnown: t.coordsKnown ?? true, zone: t.zone, activityType: t.activityType,
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

/** Дорожный граф: база рыбалки — 410 км, ≈6,3 ч; остальное — рядом. */
const roadCalls: Array<[number, number]> = [];
vi.mock('@/lib/planner/road-hours', () => ({
  roadEstimate: vi.fn(async (_a: [number, number], b: [number, number]) => {
    roadCalls.push(b);
    if (Math.abs(b[0] - 55.433) < 0.01) return { kind: 'road', km: 410.3, hours: 6.33 };
    if (Math.abs(b[0] - 52.3) < 0.01) return { kind: 'no_road' };
    if (Math.abs(b[0] - 52.0) < 0.01) return { kind: 'road', km: 260, hours: 4.4 };
    if (Math.abs(b[0] - 52.55) < 0.01) return { kind: 'road', km: 107, hours: 2.1 };
    return { kind: 'road', km: 60, hours: 1.2 };
  }),
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
          ? { rows: TREK_ROUTES ?? [{ id: 'r-trek-ok', title: 'Тропа к Сухой речке', zone, activity_type: act, lat: 53.1, lng: 158.6, location_type: null }] }
          : { rows: [] };
      }
      return { rows: [] };
    }),
  },
}));

import { recommendTrip, type TripProfile } from '@/lib/planner/engine';
import { NO_TOUR_DAY_TITLE, NO_SELF_ROUTE_DAY_TITLE } from '@/lib/planner/honest-days';
import {
  DAY_TRIP_MAX_ROAD_HOURS, tooFarForDayTrip, farDayTourLine, isAirTour, hoursRu, pointUnknownLine,
} from '@/lib/planner/road-reach';
import { readFileSync } from 'node:fs';

const NEXT = new Date().getUTCFullYear() + 1;
const WINTER: TripProfile = {
  interests: ['hot_spring', 'fishing', 'snowmobile'],
  arrivalDate: `${NEXT}-11-24`, departureDate: `${NEXT}-12-04`,
  adults: 2, children: [], fitnessLevel: 'moderate', budgetTier: 'comfort', travelStyle: 'mixed',
};
/** Как ID36 на проде: однодневная рыбалка, база на р. Камчатке (55,43 / 159,42). */
const FISH_FAR: Tour = { tourId: 't-fish36', title: 'Зимняя рыбалка: ноябрь — январь', zone: 'avachinsky', activityType: 'fishing',
  lat: 55.433459, lng: 159.423, included: ['Размещение на базе', 'Трансферы до места ловли'] };
/** Как ID112: точки места у тура нет. */
const THERMAL5: Tour = { tourId: 't-thermal5', title: 'Камчатка: термальный маршрут', zone: 'avachinsky', activityType: 'hot_spring',
  durationHours: 5 * 24, coordsKnown: false, lat: 53.01, lng: 158.65 };
const SNOW: Tour = { tourId: 't-snow', title: 'Снегоходы', zone: 'avachinsky', activityType: 'snowmobile', lat: 53.1, lng: 158.7 };
/** Однодневный тур без дороги в графе — остаётся, но назван. */
const BOAT: Tour = { tourId: 't-boat', title: 'Рыбалка в бухте Ходутка', zone: 'avachinsky', activityType: 'fishing', lat: 52.3, lng: 158.2 };

describe('аудит дорог 22.11: однодневный тур дальше порога одним днём не ставится', () => {
  beforeEach(() => { roadCalls.length = 0; });

  it('порог — одно число, 3 ч в одну сторону; «оценка» в каждой строке', () => {
    expect(DAY_TRIP_MAX_ROAD_HOURS).toBe(3);
    expect(tooFarForDayTrip({ kind: 'road', km: 410, hours: 6.33 })).toBe(true);
    expect(tooFarForDayTrip({ kind: 'road', km: 106, hours: 2.05 })).toBe(false);
    expect(tooFarForDayTrip({ kind: 'no_road' })).toBe(false);
    expect(tooFarForDayTrip({ kind: 'unread' })).toBe(false);
    expect(hoursRu(6.33)).toBe('≈6,3 ч');
    const line = farDayTourLine('Зимняя рыбалка', { km: 410.3, hours: 6.33 });
    expect(line).toContain('410 км, ≈6,3 ч по дороге в одну сторону (оценка');
    expect(line).toContain('день дороги туда и день обратно');
    expect(pointUnknownLine(['А'])).toContain('нет точки места');
    expect(isAirTour({ title: 'Облёт вулканов Мутновский и Горелый' })).toBe(true);
    expect(isAirTour({ title: 'Зимняя рыбалка', included: ['Размещение на базе'] })).toBe(false);
    // Порог живёт в одном месте: в движке своего числа нет.
    const engine = readFileSync('lib/planner/engine.ts', 'utf8');
    expect(engine).not.toMatch(/hours\s*>\s*3\b/);
  });

  it('кейс ID36 (24.11–04.12), этап 3: рыбалка в 410 км с проживанием — связкой «дорога + тур + дорога»; термальный без точки — назван', async () => {
    KEEPS = { 't-fish36': false, 't-thermal5': false, 't-snow': false, 't-boat': false };
    ON_REQUEST = new Set(['hot_spring', 'fishing', 'snowmobile']);
    TOURS = { 'avachinsky:hot_spring': [THERMAL5], 'avachinsky:fishing': [FISH_FAR], 'avachinsky:snowmobile': [SNOW] };
    const rec = await recommendTrip(WINTER);
    const at = rec.days.findIndex((d) => d.realTour?.tourId === 't-fish36');
    expect(at).toBeGreaterThan(0);
    const before = rec.days[at - 1];
    const after = rec.days[at + 1];
    expect(before.type).toBe('travel');
    expect(before.roadLeg).toMatchObject({ tourId: 't-fish36', direction: 'to', nightOnSite: 'tour' });
    expect(before.description).toContain('410 км, ≈6,3 ч по дороге в одну сторону (оценка');
    expect(before.description).toContain('Трансфер план не бронирует и не обещает');
    expect(after.roadLeg).toMatchObject({ tourId: 't-fish36', direction: 'back' });
    expect(rec.days.some((d) => d.realTour?.tourId === 't-snow')).toBe(true);
    const text = rec.warnings.map((w) => w.message).join('\n');
    expect(text).toContain('«Зимняя рыбалка: ноябрь — январь» стоит связкой из трёх дней');
    const thermal = rec.days.filter((d) => d.realTour?.tourId === 't-thermal5');
    expect(thermal).toHaveLength(0);
    expect(text).toMatch(/термальный маршрут/);
    expect(text).toMatch(/основу автоплана/);
    // Ночи связки — у места: жильё города на них не ищется.
    const { nightLodgingIncluded } = await import('@/lib/planner/lodging-included');
    expect(nightLodgingIncluded(before, rec.days[at])).toBe(true);
    expect(nightLodgingIncluded(rec.days[at], after)).toBe(true);
    expect(nightLodgingIncluded(after, rec.days[at + 2])).not.toBe(true);
    // Тур без точки и ближний (<40 км по прямой) граф не спрашивают.
    expect(roadCalls.every((b) => Math.abs(b[0] - 53.01) > 0.01 && Math.abs(b[0] - 53.1) > 0.01)).toBe(true);
  });

  it('этап 3: далёкий тур без проживания в составе — не ставится, сказано, что ночлега у места нет', async () => {
    const NO_NIGHT: Tour = { ...FISH_FAR, tourId: 't-fish-nonight', title: 'Рыбалка без ночлега', included: ['Сопровождение гида'] };
    KEEPS = { 't-fish-nonight': false, 't-snow': false };
    ON_REQUEST = new Set(['fishing', 'snowmobile']);
    TOURS = { 'avachinsky:fishing': [NO_NIGHT], 'avachinsky:snowmobile': [SNOW] };
    const rec = await recommendTrip({ ...WINTER, interests: ['fishing', 'snowmobile'] });
    expect(rec.days.some((d) => d.realTour?.tourId === 't-fish-nonight')).toBe(false);
    expect(rec.days.some((d) => d.roadLeg)).toBe(false);
    const text = rec.warnings.map((w) => w.message).join('\n');
    expect(text).toContain('ночлега у места в составе тура нет');
    expect(text).toContain('Жилья на платформе в 30 км от места тоже нет');
  });

  it('этап 3: связка не помещается в короткую поездку — тур не ставится, сказано, сколько дней нужно', async () => {
    KEEPS = { 't-fish36': false };
    ON_REQUEST = new Set(['fishing']);
    TOURS = { 'avachinsky:fishing': [FISH_FAR] };
    const rec = await recommendTrip({ ...WINTER, interests: ['fishing'], departureDate: `${NEXT}-11-27` });
    expect(rec.days.some((d) => d.realTour?.tourId === 't-fish36')).toBe(false);
    expect(rec.warnings.map((w) => w.message).join('\n')).toMatch(/нужна связка из 3 дней|однодневный тур, а до его места/);
  });

  it('прод 22.11, лето (ID5): блок короток, а дальние зоны без туров отпали — связка встаёт хвостом, без «дней не осталось»', async () => {
    const V1: Tour = { tourId: 't-v1', title: 'Вулкан один', zone: 'avachinsky', activityType: 'volcanoes', lat: 53.25, lng: 158.8 };
    const V2: Tour = { tourId: 't-v2', title: 'Вулкан два', zone: 'avachinsky', activityType: 'volcanoes', lat: 53.26, lng: 158.8 };
    KEEPS = { 't-fish36': false, 't-v1': false, 't-v2': false };
    ON_REQUEST = new Set(['fishing', 'volcanoes']);
    TOURS = { 'avachinsky:fishing': [FISH_FAR], 'avachinsky:volcanoes': [V1, V2] };
    const rec = await recommendTrip({ ...WINTER, interests: ['volcanoes', 'fishing', 'geysers', 'bears'],
      arrivalDate: `${NEXT}-07-10`, departureDate: `${NEXT}-07-17` });
    const text = rec.warnings.map((w) => w.message).join('\n');
    const placed = rec.days.some((d) => d.realTour?.tourId === 't-fish36');
    // До правки (прод 22.11): тур снимался с «дней не осталось», дни оставались пустыми.
    expect(placed).toBe(true);
    expect(text).toContain('стоит связкой из трёх дней');
    expect(text).not.toContain('нужна связка из 3 дней');
    expect(text).not.toContain('дней не осталось');
  });

  it('далёкий тур вне сезона поездки строкой не называется (прод 22.11: «Летняя рыбалка на кижуча» в ноябре)', async () => {
    const SUMMER_FAR: Tour = { ...FISH_FAR, tourId: 't-fish-summer', title: 'Летняя рыбалка на кижуча',
      seasonStart: `${NEXT}-07-20`, seasonEnd: `${NEXT}-09-30` };
    KEEPS = { 't-fish36': false, 't-fish-summer': false, 't-snow': false };
    ON_REQUEST = new Set(['fishing', 'snowmobile']);
    TOURS = { 'avachinsky:fishing': [FISH_FAR, SUMMER_FAR], 'avachinsky:snowmobile': [SNOW] };
    const rec = await recommendTrip({ ...WINTER, interests: ['fishing', 'snowmobile'] });
    const text = rec.warnings.map((w) => w.message).join('\n');
    expect(text).toContain('«Зимняя рыбалка: ноябрь — январь» стоит связкой');
    expect(text).not.toContain('Летняя рыбалка на кижуча');
    expect(rec.days.some((d) => d.realTour?.tourId === 't-fish-summer')).toBe(false);
  });

  it('тур без дороги в графе остаётся в плане, но сказано, что везёт оператор', async () => {
    KEEPS = { 't-boat': false, 't-snow': false };
    ON_REQUEST = new Set(['fishing', 'snowmobile']);
    TOURS = { 'avachinsky:fishing': [BOAT], 'avachinsky:snowmobile': [SNOW] };
    const rec = await recommendTrip({ ...WINTER, interests: ['fishing', 'snowmobile'] });
    expect(rec.days.some((d) => d.realTour?.tourId === 't-boat')).toBe(true);
    expect(rec.warnings.map((w) => w.message).join('\n')).toMatch(/До места тура «Рыбалка в бухте Ходутка» проезжей дороги в нашем дорожном графе нет/);
  });

  it('этап 3, п. 2: маршрут «сам» дальше 3 ч днём не ставится; ближе — строка км/ч «оценка»', async () => {
    TOURS = {};
    TREK_ROUTES = [
      { id: 'r-far', title: 'Дальняя тропа', zone: 'avachinsky', activity_type: 'trekking', lat: 52.0, lng: 157.9, location_type: null },
      { id: 'r-mid', title: 'Мутновско-Гореловская группа', zone: 'avachinsky', activity_type: 'trekking', lat: 52.55, lng: 158.1, location_type: null },
      { id: 'r-off', title: 'Тропа без подъезда', zone: 'avachinsky', activity_type: 'trekking', lat: 52.3, lng: 158.4, location_type: null },
    ];
    try {
      const rec = await recommendTrip({ ...WINTER, interests: ['trekking'], travelStyle: 'self',
        arrivalDate: `${NEXT}-08-05`, departureDate: `${NEXT}-08-13` });
      expect(rec.days.some((d) => d.routeId === 'r-far')).toBe(false);
      const mid = rec.days.find((d) => d.routeId === 'r-mid');
      expect(mid).toBeDefined();
      expect(mid!.dayWarnings.join('\n')).toContain('107 км, ≈2,1 ч по дороге в одну сторону (оценка');
      // Старт далеко от дорог графа (прод 22.11: Горелый, 13,7 км) — не молчание, а «не оценили».
      const off = rec.days.find((d) => d.routeId === 'r-off');
      expect(off).toBeDefined();
      expect(off!.dayWarnings.join('\n')).toContain('Подъезд к началу маршрута по дороге мы не оценили');
      const text = rec.warnings.map((w) => w.message).join('\n');
      expect(text).toContain('Маршрут «Дальняя тропа» (самостоятельно): до него от Петропавловска 260 км, ≈4,4 ч');
    } finally {
      TREK_ROUTES = null;
    }
  });

  it('стиль «сам»: пустой день называет свою причину, а не «подходящего тура нет»', async () => {
    TOURS = {};
    const rec = await recommendTrip({ ...WINTER, interests: ['trekking', 'hot_spring'], travelStyle: 'self',
      arrivalDate: `${NEXT}-08-05`, departureDate: `${NEXT}-08-13` });
    expect(rec.days.some((d) => d.title === NO_TOUR_DAY_TITLE)).toBe(false);
    expect(rec.days.some((d) => d.title === NO_SELF_ROUTE_DAY_TITLE)).toBe(true);
  });
});

describe('связка в правках плана (Bugbot #3722)', () => {
  it('дни дороги — в группе своего тура; каркас назван «день дороги», не «переезд между зонами»', async () => {
    const { tourGroup, frameWordOf } = await import('@/lib/planner/plan-ops');
    const days = [
      { day: 2, type: 'travel', roadLeg: { tourId: 'T36' } },
      { day: 3, type: 'activity', realTour: { tourId: 'T36' } },
      { day: 4, type: 'travel', roadLeg: { tourId: 'T36' } },
      { day: 5, type: 'activity' },
    ];
    expect(tourGroup(days, days[1]).map((d) => d.day)).toEqual([2, 3, 4]);
    expect(tourGroup(days, days[0]).map((d) => d.day)).toEqual([2, 3, 4]);
    expect(tourGroup(days, days[3]).map((d) => d.day)).toEqual([5]);
    expect(frameWordOf(days[0])).toContain('день дороги');
    expect(frameWordOf({ type: 'travel' })).toBe('переезд между зонами');
  });

  it('состав тура не указан — строка говорит «не указал», а не «нет»', async () => {
    const { farNoNightLine, farBundleNoDateLine } = await import('@/lib/planner/road-reach');
    const e = { km: 411, hours: 6.3 };
    expect(farNoNightLine('Рыбалка', e, [], false)).toContain('оператор не указал');
    expect(farNoNightLine('Рыбалка', e, [])).toContain('ночлега у места в составе тура нет');
    expect(farBundleNoDateLine('Рыбалка', e)).toContain('нет его выезда');
  });
});
