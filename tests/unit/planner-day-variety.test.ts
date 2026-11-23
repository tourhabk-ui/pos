/**
 * План владельца 23.11 (24.11–04.12, 2 взрослых + дети 5/11/17, комфорт,
 * смешанный, интересы по умолчанию): после возраста и сезона оставался один
 * интерес «источники», и дни забивались термами. Пятидневный тур не режется.
 * Красное закрытие парка на карточке места не прячется за возрастом.
 *
 * Движок на подменённом хранилище: без LLM, без ПД, без живой базы.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ACTIVITY_CONSTRAINTS } from '@/lib/planner/constants';
import { outingCap, varietyAdmit, varietyKey } from '@/lib/planner/day-variety';
import { liveCardCoversDate, recordedMinAge } from '@/lib/planner/tour-gates';
import { buildRefusal } from '@/lib/kuzmich/trip-plan-tool';
import { assignCatalogFreeDays, type SelfPlace } from '@/lib/planner/self-fill';
import { NO_TOUR_DAY_TITLE } from '@/lib/planner/honest-days';
import type { DayPlan, TripProfile } from '@/lib/planner/engine';

interface PlaceCard {
  name: string;
  zone: string | null;
  lat: number | null;
  lng: number | null;
  openFrom?: string | null;
  openTo?: string | null;
  level?: 'red' | 'yellow' | 'green' | 'closed' | 'unknown' | null;
  closed?: boolean;
  parkSummary?: string | null;
}
interface Tour {
  tourId: string;
  title: string;
  zone: string;
  activityType: string;
  durationHours?: number;
  shortDescription?: string | null;
  place?: PlaceCard | null;
}
let TOURS: Record<string, Tour[]> = {};
let KEEPS: Record<string, boolean | null> = {};
let SLOTS: Record<string, string[]> = {};
let PARK_CLOSED = new Set<string>();

const KLYU = 'Ключевской — маршруты закрыты на зимний сезон: Передвижение в районах вулканов крайне опасно';
const SEASONAL = 'Маршруты природного парка «Налычево» закрыты на период межсезонья';

function realTour(t: Tour) {
  return {
    tourId: t.tourId, title: t.title, shortDescription: t.shortDescription ?? null,
    operatorName: 'Оператор', operatorSlug: 'op', operatorRating: null, operatorReviewCount: 0,
    operatorVerified: false, tourRating: null, tourReviewCount: 0, basePrice: 20000, priceUnit: 'per_person',
    maxParticipants: 10, minParticipants: 1, durationHours: t.durationHours ?? 10, difficulty: null,
    weatherDependent: false, seasonStart: null, seasonEnd: null, included: null,
    lat: t.place?.lat ?? 53, lng: t.place?.lng ?? 158, coordsKnown: true, zone: t.zone, activityType: t.activityType,
    place: t.place ?? null,
  };
}

vi.mock('@/lib/planner/data', () => ({
  createPlannerCache: () => new Map(),
  fetchRealToursForZone: vi.fn(async (zone: string, act: string, limit: number) =>
    (TOURS[`${zone}:${act}`] ?? []).slice(0, limit).map(realTour)),
  fetchAvailabilityForTour: vi.fn(async (id: string, from: string, to: string) =>
    (SLOTS[id] ?? []).filter((d) => d >= from && d <= to).map((date) => ({ date, availableSlots: 22, bookedSlots: 0, remaining: 22, priceOverride: null }))),
  fetchZoneCapacity: vi.fn(async () => ({ tourCount: 0, totalSlots: 0, totalBooked: 0, utilizationPercent: 0 })),
  fetchContingencyAlternatives: vi.fn(async () => []),
  fetchReviewSignals: vi.fn(async () => null),
  fetchActivitiesBookableInMonth: vi.fn(async () => new Set<string>()),
  fetchActivitiesOnRequest: vi.fn(async () => new Set(['hot_spring', 'thermal', 'helicopter'])),
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
vi.mock('@/lib/seat-requests/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/seat-requests/core')>();
  return { ...real, kamchatkaToday: () => '2026-11-23' };
});
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => null }));
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('external_alerts') && Array.isArray(params?.[1])) {
        const ids = (params[1] as string[]).filter((id) => PARK_CLOSED.has(id));
        return {
          rows: ids.map((id) => ({
            ref_kind: 'tour', ref_id: id, alert_id: 'a-klyu', alert_type: 'park_closure',
            title: 'Природный парк «Ключевской» — маршруты закрыты на зимний сезон',
            description: 'Передвижение в районах вулканов крайне опасно',
            published_iso: '2026-11-12T00:00:00Z', expires_iso: '2099-01-01T00:00:00Z',
          })),
        };
      }
      return { rows: [] };
    }),
  },
}));

import { recommendTrip, splitByChildAge } from '@/lib/planner/engine';

const Y = new Date().getUTCFullYear() + 1;
const iso = (m: number, d: number) => `${Y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const FAMILY: TripProfile = {
  interests: ['volcano', 'bears', 'thermal'],
  arrivalDate: iso(11, 24), departureDate: iso(12, 4),
  adults: 2, children: [5, 11, 17], fitnessLevel: 'moderate', budgetTier: 'comfort', travelStyle: 'mixed',
};
const THERMAL5: Tour = {
  tourId: 't-112', title: 'Камчатка: термальный маршрут', zone: 'avachinsky', activityType: 'thermal', durationHours: 5 * 24,
};
const MALKI: Tour = { tourId: 't-82', title: 'Малкинские источники', zone: 'avachinsky', activityType: 'thermal' };
const ZELEN: Tour = { tourId: 't-106', title: 'Зеленовские озерки', zone: 'avachinsky', activityType: 'thermal' };

const TOLBACHIK: Tour = {
  tourId: 't-tolb', title: 'Вулкан Толбачик (вертолёт)', zone: 'avachinsky', activityType: 'helicopter',
  shortDescription: 'Высадка от 12 лет',
  place: {
    name: 'Вулкан Толбачик', zone: 'northern', lat: 55.818, lng: 160.39,
    openFrom: null, openTo: null, level: 'red', closed: false, parkSummary: KLYU,
  },
};
const AVA: Tour = {
  tourId: 't-ava', title: 'Облёт Авачинской бухты и Авачинского вулкана', zone: 'avachinsky', activityType: 'helicopter',
  place: { name: 'Авачинская бухта', zone: 'avachinsky', lat: 53.02, lng: 158.65, openFrom: null, openTo: null, level: 'green', closed: false, parkSummary: null },
};

beforeEach(() => {
  TOURS = {};
  KEEPS = {};
  SLOTS = {};
  PARK_CLOSED = new Set();
});

const tourIds = (rec: Awaited<ReturnType<typeof recommendTrip>>) => rec.days.map((d) => d.realTour?.tourId).filter(Boolean);
const warnings = (rec: Awaited<ReturnType<typeof recommendTrip>>) => rec.warnings.map((w) => w.message).join('\n');

describe('правило разнообразия', () => {
  it('пятидневка одной темы в основу не ставится; полный день источников — один; снегоход не подряд и не четвёртый', () => {
    expect(varietyKey('thermal')).toBe('hot_spring');
    expect(outingCap(11, 'hot_spring')).toBe(1);
    expect(outingCap(10, 'snowmobile')).toBe(3);
    expect(varietyAdmit(0, null, 'hot_spring', 5, 11).ok).toBe(false);
    expect(varietyAdmit(0, null, 'hot_spring', 1, 11).ok).toBe(true);
    expect(varietyAdmit(1, null, 'hot_spring', 1, 11)).toMatchObject({ ok: false, kind: 'cap' });
    expect(varietyAdmit(0, 'hot_spring', 'snowmobile', 1, 10).ok).toBe(true);
    expect(varietyAdmit(0, 'snowmobile', 'snowmobile', 1, 10)).toMatchObject({ ok: false, kind: 'row' });
    expect(varietyAdmit(3, null, 'snowmobile', 1, 10)).toMatchObject({ ok: false, kind: 'cap' });
    expect(varietyAdmit(0, null, 'snowmobile', 1, 10, 'Мыс Маячный', 'Мыс Маячный')).toMatchObject({ ok: false, kind: 'row' });
    expect(varietyAdmit(0, null, 'volcano', 12, 14).ok).toBe(true);
    expect(varietyAdmit(12, null, 'volcano', 1, 14)).toMatchObject({ ok: false, kind: 'cap' });
  });

  it('семья 23.11: автоплан не занимает поездку пятидневкой терм и ещё двумя днями источников', async () => {
    TOURS = { 'avachinsky:thermal': [THERMAL5, MALKI, ZELEN], 'avachinsky:hot_spring': [THERMAL5, MALKI, ZELEN] };
    KEEPS = { 't-112': false, 't-82': false, 't-106': false };
    const rec = await recommendTrip(FAMILY, { itinerary: 'plain' });
    const ids = tourIds(rec);
    expect(ids).not.toContain('t-112');
    const springDays = rec.days.filter((d) => d.realTour && (d.activityType === 'hot_spring' || d.activityType === 'thermal'));
    expect(springDays.length).toBeLessThanOrEqual(1);
    for (let i = 1; i < rec.days.length; i++) {
      const a = rec.days[i - 1]!;
      const b = rec.days[i]!;
      const spring = (d: typeof a) => Boolean(d.realTour) && (d.activityType === 'hot_spring' || d.activityType === 'thermal');
      if (spring(a) && spring(b)) expect(a.realTour?.tourId).toBe(b.realTour?.tourId);
    }
    const text = warnings(rec);
    expect(text).toMatch(/термальный маршрут/);
    expect(text).toMatch(/резать его нельзя/);
    expect(text).toMatch(/основу автоплана/);
    expect(text).not.toMatch(/Не поместились в срок поездки/);
    expect(rec.days.some((d) => d.title === 'Резервный день на погоду')).toBe(true);
    const nums = rec.days.map((d) => d.day);
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
    expect(text).toMatch(/Вулканы:[\s\S]*12 лет[\s\S]*не в сезоне/);
    expect(text).toMatch(/Медведи:[\s\S]*6 лет[\s\S]*не в сезоне/);
  });
});

describe('красное закрытие парка в плане', () => {
  it('Толбачик назван и возрастом, и закрытием парка; облёт Авачи не путается с Ключевским', async () => {
    TOURS = { 'avachinsky:helicopter': [TOLBACHIK, AVA] };
    KEEPS = { 't-tolb': false, 't-ava': true };
    SLOTS = { 't-ava': [iso(11, 24), iso(11, 25), iso(11, 26), iso(11, 27), iso(11, 28), iso(11, 29), iso(11, 30)] };
    const rec = await recommendTrip({
      ...FAMILY, interests: ['helicopter'], tripOrigin: 'visitor',
    }, { itinerary: 'plain' });
    expect(tourIds(rec)).not.toContain('t-tolb');
    expect(tourIds(rec)).toContain('t-ava');
    const text = warnings(rec);
    expect(text).toMatch(/Не ставили: «Вулкан Толбачик \(вертолёт\)»/);
    expect(text).toMatch(/ребёнок 5 лет/);
    expect(text).toMatch(/от 12 лет/);
    expect(text).toMatch(/парк у места тура закрыт/);
    expect(text).toMatch(/не сезон/);
    expect(text).not.toMatch(/Облёт Авачинской бухты[\s\S]{0,80}Ключевск/);
  });

  it('зимняя карточка не снимает летний тур без тревоги на эту дату', async () => {
    expect(liveCardCoversDate('2026-11-23', `${Y}-11-24`)).toBe(true);
    expect(liveCardCoversDate('2026-11-23', `${Y}-07-15`)).toBe(false);
    expect(liveCardCoversDate('2026-07-15', `${Y}-08-01`)).toBe(true);
    expect(liveCardCoversDate('2026-07-15', `${Y}-12-01`)).toBe(false);
    TOURS = { 'avachinsky:helicopter': [TOLBACHIK] };
    KEEPS = { 't-tolb': false };
    const rec = await recommendTrip({
      interests: ['helicopter'],
      arrivalDate: `${Y}-07-10`, departureDate: `${Y}-07-16`,
      adults: 2, children: [], fitnessLevel: 'moderate', budgetTier: 'comfort', travelStyle: 'mixed',
      tripOrigin: 'visitor',
    }, { itinerary: 'plain' });
    expect(tourIds(rec)).toContain('t-tolb');
    expect(warnings(rec)).not.toMatch(/закрыт по сводке/);
  });

  it('резерв на погоду стоит в свою дату, а не после более позднего дня', async () => {
    const climb: Tour = {
      tourId: 't-climb', title: 'Ключевская за четыре дня', zone: 'avachinsky',
      activityType: 'volcano', durationHours: 4 * 24,
    };
    TOURS = { 'avachinsky:volcano': [climb] };
    KEEPS = { 't-climb': false };
    const rec = await recommendTrip({
      interests: ['volcano'],
      arrivalDate: `${Y}-06-26`, departureDate: `${Y}-07-05`,
      adults: 2, children: [], fitnessLevel: 'active', budgetTier: 'comfort', travelStyle: 'operator',
    });
    const nums = rec.days.map((d) => d.day);
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
    const reserve = rec.days.find((d) => d.title === 'Резервный день на погоду');
    expect(reserve).toBeDefined();
    expect(rec.days.some((d) => d.realTour && d.day > reserve!.day)).toBe(true);
  });

  it('межсезонье без опасности красным закрытием тур не снимает', async () => {
    const seasonal: Tour = {
      ...TOLBACHIK,
      tourId: 't-season',
      title: 'Налычево без высадки',
      shortDescription: null,
      place: {
        name: 'Налычево', zone: 'avachinsky', lat: 53.5, lng: 159.0,
        openFrom: null, openTo: null, level: 'red', closed: false, parkSummary: SEASONAL,
      },
    };
    TOURS = { 'avachinsky:helicopter': [seasonal] };
    KEEPS = { 't-season': false };
    const rec = await recommendTrip({
      ...FAMILY, interests: ['helicopter'], children: [], tripOrigin: 'visitor',
    }, { itinerary: 'plain' });
    expect(tourIds(rec)).toContain('t-season');
    expect(warnings(rec)).not.toMatch(/Налычево без высадки[\s\S]{0,120}закрыт по сводке/);
  });
});

describe('несколько причин и пороги', () => {
  it('ноябрь с ребёнком называет и возраст, и сезон; июль возраст сезоном не подменяет', () => {
    const blocked = splitByChildAge(['volcano'], 5).blocked;
    const november = buildRefusal(11, ['volcano'], 'https://vedarai.ru', null, blocked);
    expect(november).toMatch(/По возрасту младшего \(5\)/);
    expect(november).toMatch(/не сезон: вулканы/i);
    const july = buildRefusal(7, ['volcano'], 'https://vedarai.ru', null, blocked);
    expect(july).not.toMatch(/не сезон: вулканы/i);
  });

  it('пороги 12, 6, 18 и 21 не сдвинулись', () => {
    expect(ACTIVITY_CONSTRAINTS.volcano.minChildAge).toBe(12);
    expect(ACTIVITY_CONSTRAINTS.bears.minChildAge).toBe(6);
    expect(recordedMinAge('программа от 18 лет')).toBe(18);
    expect(recordedMinAge('программа от 21 лет')).toBe(21);
  });
});

describe('самостоятельные дни тем же правилом', () => {
  const free = (day: number): DayPlan => ({
    day, type: 'activity', zone: 'avachinsky', title: NO_TOUR_DAY_TITLE, description: '',
    activityType: 'thermal', priceFrom: 0, priceTo: 0, coords: [53, 158],
    defaultTransport: 'walking', allowedTransports: ['walking'], difficulty: 'easy',
    childFriendly: true, minChildAge: 0, dayWarnings: [],
  });
  const museum: SelfPlace = { name: 'Краеведческий музей', href: '/places/museum', type: 'museum', lat: 53.02, lng: 158.65 };
  const spring: SelfPlace = { name: 'Паратунка', href: '/places/paratunka', type: 'hot_spring', lat: 52.9, lng: 158.3 };

  it('два пустых дня подряд не становятся двумя музеями, если музея в пуле один', () => {
    const days = assignCatalogFreeDays([free(1), free(2)], [museum], '');
    expect(days[0]!.title).toBe('Самостоятельно: Краеведческий музей');
    expect(days[1]!.title).toBe(NO_TOUR_DAY_TITLE);
  });

  it('музей и источник чередуются, второй источник не ставится', () => {
    const days = assignCatalogFreeDays([free(1), free(2), free(3)], [spring, museum], '');
    const kinds = days.map((d) => d.placeKind ?? null);
    expect(kinds[0]).toBe('museum');
    expect(kinds[1]).toBe('hot_spring');
    expect(kinds.filter((k) => k === 'hot_spring')).toHaveLength(1);
    expect(days[2]!.title).toBe(NO_TOUR_DAY_TITLE);
  });

  it('зимнее ядро берёт океан, музей и этно из каталога и не выдумывает собак', () => {
    const ocean: SelfPlace = { name: 'Авачинская бухта', href: '/places/avacha-bay', type: 'bay', lat: 53.02, lng: 158.65 };
    const ethno: SelfPlace = { name: 'Пимчах', href: '/places/pimchakh', type: 'ethnic', lat: 53.1, lng: 158.4 };
    const days = assignCatalogFreeDays([free(1), free(2), free(3), free(4)], [spring, museum, ocean, ethno], '');
    expect(days.map((d) => d.placeKind)).toEqual(['bay', 'museum', 'ethnic', 'hot_spring']);
    expect(days.map((d) => d.title).join('\n')).not.toMatch(/собак/);
  });
});
