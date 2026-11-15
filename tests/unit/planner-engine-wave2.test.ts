/**
 * Разбор планера 14.11, движок — вторая партия: что день и сводка говорят о
 * себе. Настоящий `recommendTrip` на подменённом хранилище (подмена из
 * planner-prod-proof) и правила — вызовом (CLAUDE.md §4).
 *
 *   6  — укачивает, а тур на катере: день не переименовывается в «береговой»;
 *   8  — отдых после общего дня не занимает дату единственного выезда тура;
 *   9  — «со свободными местами» только когда группа входит;
 *   10 — общий день вне сезона говорит «не сезон» и у занятия «только с гидом»;
 *   14 — альтернатива ребёнку не с тем же порогом возраста;
 *   15 — занятие словами, без ключей движка и опечаток.
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
/** Занятия туров без календаря (открывают любой месяц по заявке). */
let ON_REQUEST: string[] = [];

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
  fetchActivitiesOnRequest: vi.fn(async () => new Set<string>(ON_REQUEST)),
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

import { recommendTrip, OUT_OF_SEASON_DAY_NOTE, type TripProfile } from '@/lib/planner/engine';
import { assessHealthCompatibility } from '@/lib/planner/intelligence';
import { ACTIVITY_CONSTRAINTS, ACTIVITY_NAMES } from '@/lib/planner/constants';

const Y = new Date().getUTCFullYear() + 1;
const BASE: TripProfile = {
  interests: [], adults: 2, children: [], budgetTier: 'comfort', tripOrigin: 'visitor', fitnessLevel: 'active',
} as unknown as TripProfile;
const plan = (p: Partial<TripProfile>) => recommendTrip({ ...BASE, ...p } as TripProfile);
const tour = (tourId: string, title: string, zone: string, activityType: string): Tour =>
  ({ tourId, title, durationHours: 10, zone, activityType });

beforeEach(() => { TOURS = {}; SLOTS = {}; SLOT_DATES = {}; KEEPS = {}; ON_REQUEST = []; safetyFails = false; alertsFail = false; });

describe('6. укачивает, тур на катере', () => {
  it('день называется туром, а не «береговым маршрутом»; ключей движка нет', async () => {
    TOURS = { 'avachinsky:boat_trip': [tour('bt', 'Авачинская бухта на катере', 'avachinsky', 'boat_trip')] };
    SLOTS = { bt: 5 };
    const rec = await plan({ interests: ['boat_trip'], seasickness: true, arrivalDate: `${Y}-07-10`, departureDate: `${Y}-07-13` } as Partial<TripProfile>);
    const day = rec.days.find((d) => d.realTour?.tourId === 'bt');
    expect(day?.title).toBe('Авачинская бухта на катере');
    expect(rec.days.some((d) => d.title.includes('береговой маршрут') && d.realTour)).toBe(false);
    const text = [...rec.warnings.map((w) => w.message), ...rec.days.flatMap((d) => d.dayWarnings)].join(' | ');
    expect(text).not.toMatch(/boat_trip|"/);
    expect(text).toContain('«морские прогулки» — выход на катере');
  });

  it('день без тура по-прежнему береговой', async () => {
    const rec = await plan({ interests: ['boat_trip'], seasickness: true, arrivalDate: `${Y}-07-10`, departureDate: `${Y}-07-13` } as Partial<TripProfile>);
    expect(rec.days.some((d) => d.title === 'Прогулка вдоль Авачинской бухты (береговой маршрут)' && !d.realTour)).toBe(true);
  });
});

describe('8. отдых после общего дня', () => {
  it('тур с единственным выездом 12.07 стоит 12.07, а не уступает его отдыху', async () => {
    TOURS = { 'avachinsky:volcano': [tour('v1', 'Авача за день', 'avachinsky', 'volcano')] };
    SLOTS = { v1: 5 };
    SLOT_DATES = { v1: [`${Y}-07-12`] };
    const rec = await plan({ interests: ['volcano'], arrivalDate: `${Y}-07-10`, departureDate: `${Y}-07-16` });
    expect(rec.days.find((d) => d.realTour?.tourId === 'v1')?.day).toBe(3);
  });

  it('после настоящего восхождения отдых остаётся', async () => {
    TOURS = { 'avachinsky:volcano': [tour('v1', 'Авача за день', 'avachinsky', 'volcano'), tour('v2', 'Горелый', 'avachinsky', 'volcano')] };
    SLOTS = { v1: 5, v2: 5 };
    const rec = await plan({ interests: ['volcano'], arrivalDate: `${Y}-07-10`, departureDate: `${Y}-07-16` });
    const at = rec.days.findIndex((d) => d.realTour?.tourId === 'v1');
    expect(rec.days[at + 1]?.type).toBe('rest');
  });
});

describe('9. «С оператором» и вместимость', () => {
  it('группа 12 при потолке тура 10 — сводка не говорит «со свободными местами»', async () => {
    TOURS = { 'avachinsky:hot_spring': [tour('p1', 'Паратунка', 'avachinsky', 'hot_spring')] };
    SLOTS = { p1: 10 };
    const rec = await plan({ interests: ['hot_spring'], adults: 12, travelStyle: 'operator', arrivalDate: `${Y}-07-10`, departureDate: `${Y}-07-12` } as Partial<TripProfile>);
    expect(rec.days.some((d) => d.realTour?.tourId === 'p1' && d.capacityWarning)).toBe(true);
    const notes = rec.preferences?.notes ?? [];
    expect(notes.some((n) => n.message.includes('со свободными местами'))).toBe(false);
    expect(notes.find((n) => n.topic === 'travel_style')?.status).toBe('partial');
  });

  it('группа входит — «со свободными местами», как раньше', async () => {
    TOURS = { 'avachinsky:hot_spring': [tour('p1', 'Паратунка', 'avachinsky', 'hot_spring')] };
    SLOTS = { p1: 10 };
    const rec = await plan({ interests: ['hot_spring'], adults: 2, travelStyle: 'operator', arrivalDate: `${Y}-07-10`, departureDate: `${Y}-07-12` } as Partial<TripProfile>);
    expect(rec.preferences?.notes.find((n) => n.topic === 'travel_style')?.status).toBe('honoured');
  });
});

describe('10. общий день вне сезона по заявке', () => {
  it('февраль, вулканы туров без календаря: на общем дне — и «не сезон», и «только с гидом»', async () => {
    ON_REQUEST = ['volcano'];
    const rec = await plan({ interests: ['volcano'], arrivalDate: `${Y}-02-10`, departureDate: `${Y}-02-14` });
    const generic = rec.days.filter((d) => d.type === 'activity' && d.activityType === 'volcano' && !d.realTour);
    for (const d of generic) {
      expect(d.dayWarnings).toContain(OUT_OF_SEASON_DAY_NOTE);
      expect(d.dayWarnings.some((w) => w.startsWith('Только с гидом'))).toBe(true);
    }
  });
});

describe('14–15. слова человеку', () => {
  it('альтернатива ребёнку младше порога не называет тот же порог', () => {
    for (const [key, c] of Object.entries(ACTIVITY_CONSTRAINTS)) {
      if (!c.childAlternative) continue;
      expect(c.childAlternative, key).not.toContain(`от ${c.minChildAge} лет`);
    }
  });

  it('здоровье: занятие словами, «термальные», не «террасные»', () => {
    const [w] = assessHealthCompatibility('boat_trip', true, undefined, undefined).warnings;
    expect(w).toMatch(/^Морские прогулки: морская болезнь/);
    expect(w).toContain('термальные источники');
    const heart = assessHealthCompatibility('volcano', false, 'гипертония, сердце', undefined).warnings.join(' ');
    expect(heart).not.toMatch(/\bvolcano\b/);
  });
});

describe('5. четыре зоны: четвёртая не отрезается молча', () => {
  const window = (days: number) => ({
    arrivalDate: `${Y}-07-05`,
    departureDate: new Date(Date.parse(`${Y}-07-05T00:00:00Z`) + (days - 1) * 86_400_000).toISOString().slice(0, 10),
  });
  beforeEach(() => {
    TOURS = {
      'northern:geyser': [tour('g1', 'Долина гейзеров', 'northern', 'geyser')],
      'western:fishing': [tour('f1', 'Опала', 'western', 'fishing')],
      'eastern:bears': [tour('b1', 'Медведи на Курильском', 'eastern', 'bears')],
      'avachinsky:volcano': [tour('v1', 'Авачинский', 'avachinsky', 'volcano')],
    };
    SLOTS = { g1: 8, f1: 8, b1: 8, v1: 8 };
  });

  // Пруф разбора: 21 день, «Долина гейзеров» с местами на каждый день, а
  // Северной зоны в плане не было, пять дней пустые и в «Важно» — «тура не
  // нашли».
  it('21 день, вулканы, медведи, рыбалка, гейзеры: в плане все четыре зоны и тур к гейзерам', async () => {
    for (const interests of [['volcano', 'bears', 'fishing', 'geyser'], ['geyser', 'volcano', 'bears', 'fishing']]) {
      const r = await plan({ interests, ...window(21) });
      expect(new Set(r.zones.map((z) => z.zone)), interests.join()).toEqual(new Set(['avachinsky', 'eastern', 'western', 'northern']));
      const tours = r.days.map((d) => d.realTour?.tourId).filter(Boolean);
      expect(tours, interests.join()).toEqual(expect.arrayContaining(['g1', 'f1', 'b1']));
      expect(r.warnings.map((w) => w.message).join('\n')).not.toMatch(/подходящего тура или маршрута в ваши даты не нашли/);
    }
  });

  it('дней мало — выпавшее занятие названо причиной про дни, а не «тура не нашли»', async () => {
    const r = await plan({ interests: ['volcano', 'bears', 'fishing', 'geyser'], ...window(7) });
    const text = r.warnings.map((w) => w.message).join('\n');
    expect(text).not.toMatch(/подходящего тура или маршрута в ваши даты не нашли/);
    // Каждое занятие без дня названо по-русски — и причиной про дни.
    const unserved = ['geyser', 'fishing', 'bears'].filter((i) => !r.days.some((d) => d.activityType === i && d.type === 'activity'));
    expect(unserved.length).toBeGreaterThan(0);
    for (const i of unserved) {
      const line = r.warnings.map((w) => w.message)
        .find((m) => m.toLowerCase().includes(ACTIVITY_NAMES[i]!) && /не вош(ёл|ла|ло)/.test(m));
      expect(line, i).toBeDefined();
      expect(line, i).toMatch(/дн(я|ей)/);
    }
  });
});

describe('11. без дат — сказано, почему план пустой', () => {
  it('дней нет, и строка «Даты поездки не указаны»; сезон не «в выбранный период»', async () => {
    const r = await plan({ interests: ['volcano', 'snowmobile'] });
    expect(r.days).toEqual([]);
    const dates = r.warnings.find((w) => w.type === 'dates');
    expect(dates?.message).toMatch(/Даты поездки не указаны/);
    expect(r.warnings.map((w) => w.message).join('\n')).not.toMatch(/в выбранный период/);
  });

  it('с датами строки о датах нет', async () => {
    const r = await plan({ interests: ['volcano'], arrivalDate: `${Y}-07-05`, departureDate: `${Y}-07-11` });
    expect(r.warnings.some((w) => w.type === 'dates')).toBe(false);
  });
});

describe('13. предупреждения — про занятия плана, а не про всю просьбу', () => {
  it('вулкан не по возрасту — нет строки «нужна подготовка» про вулканы', async () => {
    const r = await plan({
      interests: ['volcano', 'hot_spring'], children: [11], fitnessLevel: 'beginner',
      arrivalDate: `${Y}-07-05`, departureDate: `${Y}-07-11`,
    } as Partial<TripProfile>);
    const text = r.warnings.map((w) => w.message);
    expect(text.some((m) => /Вулканы.*в план не вошло/.test(m))).toBe(true);
    expect(text.some((m) => /Вулканы.*нужна .* подготовка/.test(m))).toBe(false);
  });

  it('гейзеры не по возрасту — в строке о вертолёте их нет', async () => {
    TOURS = { 'northern:geyser': [tour('g1', 'Долина гейзеров', 'northern', 'geyser')] };
    SLOTS = { g1: 8 };
    const r = await plan({
      interests: ['geyser', 'helicopter'], children: [7],
      arrivalDate: `${Y}-07-05`, departureDate: `${Y}-07-14`,
    } as Partial<TripProfile>);
    const heli = r.warnings.find((w) => w.type === 'weather' && /Вертолётные экскурсии/.test(w.message));
    if (heli) expect(heli.message).not.toMatch(/гейзеры/);
    expect(r.days.some((d) => d.activityType === 'geyser' && d.type === 'activity')).toBe(false);
  });
});
