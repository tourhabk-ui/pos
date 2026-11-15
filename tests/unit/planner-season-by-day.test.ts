/**
 * Сезон — по дате каждого дня, день на возвращение из дальней зоны и резерв
 * на нелётную погоду после возвращения (разбор планера 14.11, движок-1/2/3/4/7/17).
 *
 * Судится план, который отдаёт настоящий `recommendTrip` на подменённом
 * хранилище (та же подмена, что в planner-prod-proof), и правило сезона —
 * вызовом на граничных датах (CLAUDE.md §4).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Подмена хранилища ────────────────────────────────────────────────────

interface Tour {
  tourId: string; title: string; durationHours: number | null; zone: string; activityType: string;
  seasonStart?: string; seasonEnd?: string;
}
/** Туры по паре «зона:активность» — свои в каждом тесте. */
let TOURS: Record<string, Tour[]> = {};
/** Свободные места по туру на даты поездки. Нет ключа — мест нет. */
let SLOTS: Record<string, number> = {};
/** Даты выезда тура, если не все дни окна (YYYY-MM-DD). Нет ключа — все. */
let SLOT_DATES: Record<string, string[]> = {};
/** Ведёт ли тур календарь. Нет ключа — ведёт. */
let KEEPS: Record<string, boolean> = {};

function realTour(t: Tour) {
  return {
    tourId: t.tourId, title: t.title, shortDescription: null,
    operatorName: 'Оператор', operatorSlug: 'op', operatorRating: 4.5, operatorReviewCount: 3,
    operatorVerified: true, tourRating: null, tourReviewCount: 0, basePrice: 10000, priceUnit: 'per_person',
    maxParticipants: 10, minParticipants: 1, durationHours: t.durationHours, difficulty: null,
    weatherDependent: false, seasonStart: t.seasonStart ?? null, seasonEnd: t.seasonEnd ?? null, included: null,
    lat: 53, lng: 158, zone: t.zone, activityType: t.activityType,
  };
}

vi.mock('@/lib/planner/data', () => ({
  createPlannerCache: () => new Map(),
  fetchRealToursForZone: vi.fn(async (zone: string, act: string, limit: number) =>
    (TOURS[`${zone}:${act}`] ?? []).slice(0, limit).map(realTour)),
  fetchAvailabilityForTour: vi.fn(async (tourId: string, from: string, to: string) => {
    if (!SLOTS[tourId]) return [];
    const out = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
      const date = new Date(t).toISOString().slice(0, 10);
      if (SLOT_DATES[tourId] && !SLOT_DATES[tourId].includes(date)) continue;
      out.push({ date, availableSlots: 10, bookedSlots: 10 - SLOTS[tourId], remaining: SLOTS[tourId], priceOverride: null });
    }
    return out;
  }),
  fetchZoneCapacity: vi.fn(async () => ({ tourCount: 0, totalSlots: 0, totalBooked: 0, utilizationPercent: 0 })),
  fetchContingencyAlternatives: vi.fn(async () => []),
  fetchReviewSignals: vi.fn(async () => null),
  fetchActivitiesBookableInMonth: vi.fn(async () => new Set<string>()),
  // Туров без календаря в этих снимках нет; у тура с пустыми датами
  // расписание есть — «мест нет» (tests/unit/planner-on-request-tours).
  fetchActivitiesOnRequest: vi.fn(async () => new Set<string>()),
  fetchTourKeepsSchedule: vi.fn(async (tourId: string) => KEEPS[tourId] ?? true),
  fetchSelfSafety: vi.fn(async (ids: string[]) => {
    if (safetyFails) return null;
    const out = new Map<string, unknown>();
    for (const id of ids) {
      const r = SAFETY[id];
      if (!r) continue;
      out.set(id, {
        isRoute: r.is_route, routeDifficulty: r.route_difficulty,
        mchsRegistrationRequired: r.mchs_registration_required,
        routeRegistrationRequired: r.route_registration_required,
        hasProfile: r.has_profile, satCommunicatorRequired: r.sat_communicator_required,
        placeRegistrationRequired: r.place_registration_required,
      });
    }
    return out;
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

const aiPrompts: string[] = [];
vi.mock('@/lib/ai/providers', () => ({
  callAIWithModelDirect: vi.fn(async (messages: Array<{ content: string }>) => {
    aiPrompts.push(messages.map((m) => m.content).join('\n'));
    return '';
  }),
}));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => null }));

/** Маршруты для самостоятельного выхода: id → зона/активность. */
const ROUTES: Array<{ id: string; title: string; zone: string; activity_type: string }> = [
  { id: 'r-trek-ok', title: 'Тропа к Сухой речке', zone: 'avachinsky', activity_type: 'trekking' },
  { id: 'r-trek-mchs', title: 'Перевал с регистрацией', zone: 'avachinsky', activity_type: 'trekking' },
  { id: 'r-trek-hard', title: 'Траверс хребта', zone: 'avachinsky', activity_type: 'trekking' },
  { id: 'r-trek-nodata', title: 'Место без профиля', zone: 'avachinsky', activity_type: 'trekking' },
  { id: 'r-volc-self', title: 'Подход к Козельскому', zone: 'avachinsky', activity_type: 'volcano' },
  { id: 'r-fish-ok', title: 'Берег Опалы', zone: 'western', activity_type: 'fishing' },
  { id: 'r-hot-ok', title: 'Источник у дороги', zone: 'avachinsky', activity_type: 'hot_spring' },
];
/** Данные безопасности по id — то, что читает `fetchSelfSafety`. */
const SAFETY: Record<string, Record<string, unknown>> = {
  'r-trek-ok':   { id: 'r-trek-ok', is_route: true, route_difficulty: 'easy', mchs_registration_required: false, route_registration_required: false, has_profile: false, sat_communicator_required: null, place_registration_required: null },
  'r-trek-mchs': { id: 'r-trek-mchs', is_route: true, route_difficulty: 'moderate', mchs_registration_required: true, route_registration_required: false, has_profile: false, sat_communicator_required: null, place_registration_required: null },
  'r-trek-hard': { id: 'r-trek-hard', is_route: true, route_difficulty: 'extreme', mchs_registration_required: false, route_registration_required: false, has_profile: false, sat_communicator_required: null, place_registration_required: null },
  'r-trek-nodata': { id: 'r-trek-nodata', is_route: false, route_difficulty: null, mchs_registration_required: null, route_registration_required: null, has_profile: false, sat_communicator_required: null, place_registration_required: null },
  'r-fish-ok':   { id: 'r-fish-ok', is_route: false, route_difficulty: null, mchs_registration_required: null, route_registration_required: null, has_profile: true, sat_communicator_required: false, place_registration_required: false },
  'r-hot-ok':    { id: 'r-hot-ok', is_route: false, route_difficulty: null, mchs_registration_required: null, route_registration_required: null, has_profile: true, sat_communicator_required: false, place_registration_required: false },
  'r-volc-self': { id: 'r-volc-self', is_route: true, route_difficulty: 'easy', mchs_registration_required: false, route_registration_required: false, has_profile: false, sat_communicator_required: null, place_registration_required: null },
};
let safetyFails = false;
/** Отказ чтения тревог платформы (`FROM safety_alerts`) — аудит 07.11, S1. */
let alertsFail = false;
/** Живые тревоги парков по ссылкам дней — то, что читает проверка парков плана. */
const PARK_ALERTS: unknown[] = [];
/** Строки сводки МЧС — то, что читает loadActiveWarnings. */
const MCHS_ROWS: unknown[] = [];

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM safety_alerts')) {
        if (alertsFail) throw Object.assign(new Error('db down'), { code: '57P01' });
        return { rows: [] };
      }
      if (sql.includes('WITH refs AS')) return { rows: PARK_ALERTS };
      if (sql.includes("alert_type IN ('volcanic_eruption', 'road_closure')")) return { rows: MCHS_ROWS };
      if (sql.includes('FROM agent_route_knowledge')) {
        const [zone, act, limit] = params as [string, string, number];
        const rows = ROUTES.filter((r) => r.zone === zone && r.activity_type === act)
          .slice(0, limit)
          .map((r) => ({ ...r, lat: 53.1, lng: 158.6, location_type: null }));
        return { rows };
      }
      if (sql.includes('location_safety_profile')) {
        if (safetyFails) throw Object.assign(new Error('db down'), { code: '57P01' });
        const ids = params[0] as string[];
        return { rows: ids.filter((id) => SAFETY[id]).map((id) => SAFETY[id]) };
      }
      return { rows: [] };
    }),
  },
}));

import { recommendTrip, type TripProfile, type DayPlan } from '@/lib/planner/engine';
import { buildTripSeason, inSeasonIn, monthOfIsoDate, monthsOutOfSeason, tripMonths } from '@/lib/planner/trip-season';
import { dateOfTripDay } from '@/lib/planner/flow-balance';
import { ACTIVITY_CONSTRAINTS } from '@/lib/planner/constants';

const Y = new Date().getUTCFullYear() + 1;
const BASE: TripProfile = {
  interests: [], adults: 2, children: [], budgetTier: 'comfort', tripOrigin: 'visitor', fitnessLevel: 'active',
} as unknown as TripProfile;
const plan = (p: Partial<TripProfile>) => recommendTrip({ ...BASE, ...p } as TripProfile);
const tour = (tourId: string, title: string, zone: string, activityType: string): Tour =>
  ({ tourId, title, durationHours: 10, zone, activityType });
/** Дата дня плана. */
const dateOf = (arrival: string, d: DayPlan) => dateOfTripDay(arrival, d.day)!;

beforeEach(() => { TOURS = {}; SLOTS = {}; SLOT_DATES = {}; KEEPS = {}; safetyFails = false; alertsFail = false; });

describe('месяц и месяцы поездки — из строки даты, без часового пояса', () => {
  it('monthOfIsoDate', () => {
    expect(monthOfIsoDate('2027-07-01')).toBe(7);
    expect(monthOfIsoDate('2027-12-31T23:00:00Z')).toBe(12);
    expect(monthOfIsoDate('')).toBeNull();
    expect(monthOfIsoDate('2027-13-01')).toBeNull();
  });

  it('tripMonths: все месяцы поездки по порядку; дат нет — запасной', () => {
    expect(tripMonths('2027-09-28', 10, 1)).toEqual([9, 10]);
    expect(tripMonths('2027-06-25', 16, 1)).toEqual([6, 7]);
    expect(tripMonths('2027-07-10', 5, 1)).toEqual([7]);
    expect(tripMonths(undefined, 5, 11)).toEqual([11]);
  });

  it('сезон месяца: таблица — пол, запись оператора месяца расширяет только свой месяц', () => {
    const s = buildTripSeason([9, 10], new Map([[9, new Set<string>()], [10, new Set(['fishing'])]]), new Set());
    expect(inSeasonIn(s, 'trekking', 9)).toBe(true);
    expect(inSeasonIn(s, 'trekking', 10)).toBe(false);
    expect(inSeasonIn(s, 'fishing', 10)).toBe(true);
    expect(monthsOutOfSeason(s, 'trekking')).toEqual([10]);
    expect(monthsOutOfSeason(s, 'fishing')).toEqual([]);
  });
});

describe('сезон — по дате дня, а не по месяцу прилёта', () => {
  it('треккинг с 28.09: ни одного дня треккинга в октябре, сказано словами', async () => {
    const arrival = `${Y}-09-28`;
    const rec = await plan({ interests: ['trekking'], arrivalDate: arrival, departureDate: `${Y}-10-07`, tripOrigin: 'local' as never });
    const trek = rec.days.filter((d) => d.type === 'activity' && d.activityType === 'trekking');
    expect(trek.length).toBeGreaterThan(0);
    for (const d of trek) expect(dateOf(arrival, d) < `${Y}-10-01`, `${d.title} на ${dateOf(arrival, d)}`).toBe(true);
    // Переезда в дальнюю зону без единого дня там нет.
    expect(rec.days.some((d) => d.type === 'travel')).toBe(false);
    expect(rec.warnings.some((w) => w.message.startsWith('Треккинг: в октябре не сезон'))).toBe(true);
    // Не «недоступно в выбранный период»: в сентябре сезон есть.
    expect(rec.warnings.some((w) => w.message.startsWith('Треккинг: недоступно'))).toBe(false);
  });

  it('два занятия в блоке: в октябре идут источники, треккинга нет', async () => {
    const arrival = `${Y}-09-28`;
    const rec = await plan({ interests: ['trekking', 'hot_spring'], arrivalDate: arrival, departureDate: `${Y}-10-07`, tripOrigin: 'local' as never });
    const october = rec.days.filter((d) => d.type === 'activity' && dateOf(arrival, d) >= `${Y}-10-01`);
    expect(october.length).toBeGreaterThan(0);
    expect(october.filter((d) => d.activityType === 'trekking').map((d) => d.title)).toEqual([]);
  });

  it('вулканы с 25.06 на 16 дней: план есть, вулканы — с 1 июля, июнь назван', async () => {
    const arrival = `${Y}-06-25`;
    TOURS = { 'avachinsky:volcano': [tour('v1', 'Авача за день', 'avachinsky', 'volcano'), tour('v2', 'Горелый', 'avachinsky', 'volcano')] };
    SLOTS = { v1: 5, v2: 5 };
    const rec = await plan({ interests: ['volcano'], arrivalDate: arrival, departureDate: `${Y}-07-10` });
    const volc = rec.days.filter((d) => d.type === 'activity' && d.activityType === 'volcano');
    expect(volc.map((d) => d.title)).toEqual(expect.arrayContaining(['Авача за день', 'Горелый']));
    for (const d of volc) expect(dateOf(arrival, d) >= `${Y}-07-01`, `${d.title} на ${dateOf(arrival, d)}`).toBe(true);
    expect(rec.warnings.some((w) => w.message.startsWith('Вулканы: в июне не сезон'))).toBe(true);
    expect(rec.warnings.some((w) => w.message.includes('все просьбы вне сезона'))).toBe(false);
  });

  it('месяц прилёта целиком вне сезона и других месяцев нет — по-прежнему «недоступно»', async () => {
    const rec = await plan({ interests: ['volcano'], arrivalDate: `${Y}-02-10`, departureDate: `${Y}-02-16` });
    expect(rec.days.some((d) => d.type === 'activity' && d.activityType === 'volcano')).toBe(false);
    expect(rec.warnings.some((w) => w.severity === 'critical' && w.message.startsWith('Вулканы: недоступно'))).toBe(true);
  });

  it('таблица сезонов не изменилась: треккинг июнь–сентябрь, вулканы июль–сентябрь', () => {
    expect(ACTIVITY_CONSTRAINTS.trekking.months).toEqual([6, 7, 8, 9]);
    expect(ACTIVITY_CONSTRAINTS.volcano.months).toEqual([7, 8, 9]);
  });
});

describe('из дальней зоны план возвращается до вылета', () => {
  it('5 дней, рыбалка только на западе: переезд, день там, возвращение, вылет', async () => {
    TOURS = { 'western:fishing': [tour('f1', 'Опала', 'western', 'fishing')] };
    SLOTS = { f1: 5 };
    const rec = await plan({ interests: ['fishing'], arrivalDate: `${Y}-07-10`, departureDate: `${Y}-07-14` });
    const types = rec.days.map((d) => `${d.type}|${d.zone}`);
    expect(types).toEqual(['arrival|avachinsky', 'travel|avachinsky', 'activity|western', 'travel|avachinsky', 'departure|avachinsky']);
    expect(rec.days[3]!.title).toBe('Возвращение: Западная зона → Петропавловск');
    expect(rec.warnings.some((w) => w.message.includes('дня на возвращение'))).toBe(false);
  });

  it('многодневный блок на западе не доходит до дня вылета', async () => {
    TOURS = { 'western:fishing': [tour('f1', 'Опала', 'western', 'fishing'), tour('f2', 'Озерная', 'western', 'fishing'), tour('f3', 'Большая', 'western', 'fishing')] };
    SLOTS = { f1: 5, f2: 5, f3: 5 };
    const rec = await plan({ interests: ['fishing'], arrivalDate: `${Y}-07-10`, departureDate: `${Y}-07-17` });
    const last = rec.days.filter((d) => d.type !== 'departure').at(-1)!;
    expect(last.zone).toBe('avachinsky');
    const back = rec.days.findIndex((d) => d.title.startsWith('Возвращение:'));
    expect(back).toBeGreaterThan(0);
    expect(rec.days.slice(back + 1).some((d) => d.zone === 'western')).toBe(false);
  });
});

describe('резерв на нелётную погоду', () => {
  it('стоит после возвращения из дальней зоны', async () => {
    TOURS = {
      'western:fishing': [tour('f1', 'Опала', 'western', 'fishing'), tour('f2', 'Озерная', 'western', 'fishing')],
      'avachinsky:helicopter': [tour('h1', 'Вертолёт', 'avachinsky', 'helicopter')],
    };
    SLOTS = { f1: 5, f2: 5, h1: 5 };
    const rec = await plan({ interests: ['fishing', 'helicopter'], arrivalDate: `${Y}-07-10`, departureDate: `${Y}-07-22` });
    const buffer = rec.days.findIndex((d) => d.type === 'buffer');
    expect(buffer).toBeGreaterThan(0);
    // После резерва — только вылет; до него ни одного дня в дальней зоне,
    // откуда ещё не вернулись.
    expect(rec.days.slice(buffer + 1).map((d) => d.type)).toEqual(['departure']);
    const westernAfter = rec.days.slice(buffer).some((d) => d.zone === 'western');
    expect(westernAfter).toBe(false);
  });

  it('вертолёта в плане нет (январь, вне сезона) — нет ни резерва, ни строки о нём', async () => {
    const rec = await plan({ interests: ['snowmobile', 'helicopter', 'volcano'], arrivalDate: `${Y}-01-10`, departureDate: `${Y}-01-14` });
    expect(rec.days.some((d) => d.type === 'buffer')).toBe(false);
    expect(rec.warnings.some((w) => w.type === 'weather' && w.message.startsWith('Вертолётные экскурсии'))).toBe(false);
    expect(rec.warnings.some((w) => w.message.includes('В план добавлен запасной день'))).toBe(false);
  });
});
