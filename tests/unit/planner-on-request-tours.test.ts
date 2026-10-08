/**
 * Планер и туры без календаря (08.10).
 *
 * make_trip_plan «вулканы, октябрь, с оператором» отвечал «В октябре это уже
 * не сезон: вулканы, треккинг» при одиннадцати турах «Края Вулканов» в
 * каталоге. Ни у одного нет расписания, а планер видел месяц только через
 * строки расписания — и вдобавок в стиле «С оператором» снимал с плана любой
 * тур без свободных дат в окне поездки, то есть тур без календаря всегда.
 *
 * Решение владельца: у тура без расписания все даты свободны для заявки.
 * Что держит сторож — на настоящем `recommendTrip` с подменённым хранилищем:
 *   — тур без календаря открывает месяц и встаёт в план «С оператором»,
 *     с отдельным предупреждением о сезоне;
 *   — тур с расписанием и без мест по-прежнему не ставится («мест нет»);
 *   — «Сам» месяц турами без календаря не открывает;
 *   — «Вперемешку» не добивает такой месяц самостоятельными выходами.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Tour { tourId: string; title: string; zone: string; activityType: string }
const TOURS: Record<string, Tour[]> = {
  'avachinsky:trekking': [
    { tourId: 't-trek', title: 'Трекинг к подножию вулкана', zone: 'avachinsky', activityType: 'trekking' },
  ],
};
/** Ведёт ли тур расписание (fetchTourKeepsSchedule). */
let KEEPS: Record<string, boolean | null> = {};
/** Активности туров без календаря (fetchActivitiesOnRequest). */
let ON_REQUEST: Set<string> | null = new Set();
const onRequestCalls: number[] = [];

function realTour(t: Tour) {
  return {
    tourId: t.tourId, title: t.title, shortDescription: null,
    operatorName: 'Край Вулканов', operatorSlug: 'op', operatorRating: null, operatorReviewCount: 0,
    operatorVerified: false, tourRating: null, tourReviewCount: 0, basePrice: 180000, priceUnit: 'per_person',
    maxParticipants: 10, minParticipants: 1, durationHours: 10, difficulty: null,
    weatherDependent: false, seasonStart: null, seasonEnd: null, included: null,
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

import { recommendTrip, OUT_OF_SEASON_DAY_NOTE, type TripProfile } from '@/lib/planner/engine';

const OCTOBER: TripProfile = {
  interests: ['trekking'],
  arrivalDate: '2026-10-12',
  departureDate: '2026-10-16',
  adults: 2,
  children: [],
  fitnessLevel: 'moderate',
  budgetTier: 'comfort',
};

beforeEach(() => {
  KEEPS = { 't-trek': false };
  ON_REQUEST = new Set(['trekking']);
  onRequestCalls.length = 0;
});

const tourDays = (days: Array<{ realTour?: { tourId: string } | null }>) =>
  days.filter((d) => d.realTour).map((d) => (d.realTour as { tourId: string }).tourId);

describe('«С оператором»: тур без календаря — в плане, сезон назван', () => {
  it('октябрь открыт туром без календаря, тур встал в план', async () => {
    const rec = await recommendTrip({ ...OCTOBER, travelStyle: 'operator' });
    expect(rec.catalogueOpen).toContain('trekking');
    expect(tourDays(rec.days)).toContain('t-trek');
    const season = rec.warnings.map((w) => w.message).join('\n');
    expect(season).toMatch(/по нашему сезонному ориентиру это уже не сезон\. Месяц открывают туры операторов без календаря/);
    expect(season).toMatch(/оператор подтвердит по заявке/);
    // Это не «оператор открыл запись на этот месяц»: строк расписания нет.
    expect(season).not.toMatch(/оператор открыл запись на этот месяц/);
  });

  it('тур с расписанием и без мест — по-прежнему не ставится', async () => {
    KEEPS = { 't-trek': true };
    const rec = await recommendTrip({ ...OCTOBER, travelStyle: 'operator' });
    expect(tourDays(rec.days)).not.toContain('t-trek');
    const notes = (rec.preferences?.notes ?? []).map((n) => n.message).join('\n');
    expect(notes).toMatch(/В ваши даты нет свободных мест: Трекинг к подножию вулкана/);
  });

  it('не смогли проверить расписание — тур остаётся, а не «мест нет»', async () => {
    KEEPS = { 't-trek': null };
    const rec = await recommendTrip({ ...OCTOBER, travelStyle: 'operator' });
    expect(tourDays(rec.days)).toContain('t-trek');
  });

  it('туры без календаря не прочитались — сказано словами', async () => {
    ON_REQUEST = null;
    const rec = await recommendTrip({ ...OCTOBER, travelStyle: 'operator' });
    expect(rec.warnings.map((w) => w.message).join('\n')).toMatch(/Не удалось проверить туры операторов без календаря/);
  });
});

describe('«Сам» и «Вперемешку»: месяц без оператора не открывается', () => {
  it('«Сам» туров без календаря не спрашивает, октябрь для треккинга закрыт', async () => {
    const rec = await recommendTrip({ ...OCTOBER, travelStyle: 'self' });
    expect(onRequestCalls).toHaveLength(0);
    expect(rec.catalogueOpen ?? []).not.toContain('trekking');
  });

  it('«Вперемешку»: тур в плане, а самостоятельной тропы в несезон нет — и это названо', async () => {
    const rec = await recommendTrip({ ...OCTOBER, travelStyle: 'mixed' });
    expect(tourDays(rec.days)).toContain('t-trek');
    expect(rec.days.map((d) => d.title)).not.toContain('Тропа к Сухой речке');
    expect(rec.warnings.map((w) => w.message).join('\n'))
      .toMatch(/Без гида не ставим: треккинг без оператора — по нашему сезонному ориентиру не сезон/);
  });

  it('«Вперемешку»: общий день в несезон говорит на самом дне, что он только с оператором', async () => {
    // Тура нет вовсе: дни треккинга — общие, и каждый обязан это сказать.
    TOURS['avachinsky:trekking'] = [];
    try {
      const rec = await recommendTrip({ ...OCTOBER, travelStyle: 'mixed' });
      // Общие дни — «на выбор» (open); свободный день в городе — не треккинг.
      const open = rec.days.filter((d) => d.activityMode === 'open');
      expect(open.length).toBeGreaterThan(0);
      for (const d of open) expect(d.dayWarnings).toContain(OUT_OF_SEASON_DAY_NOTE);
    } finally {
      TOURS['avachinsky:trekking'] = [{ tourId: 't-trek', title: 'Трекинг к подножию вулкана', zone: 'avachinsky', activityType: 'trekking' }];
    }
  });
});
