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
import { admitsAt, capSkippedLine, outingCap, outingVarietyKey, textSaysSprings, varietyAdmit, varietyKey } from '@/lib/planner/day-variety';
import { shelterBadOutings } from '@/lib/planner/weather-plan-b';
import { gateClosureFromAlerts, liveCardCoversDate, recordedMinAge, tourGate } from '@/lib/planner/tour-gates';
import { TITLE_CLIP } from '@/lib/services/safety/park-closure-hold';
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
  included?: string[] | null;
  place?: PlaceCard | null;
}
let TOURS: Record<string, Tour[]> = {};
let KEEPS: Record<string, boolean | null> = {};
let SLOTS: Record<string, string[]> = {};
let PARK_CLOSED = new Set<string>();
let PARK_EXTRA: Array<{ ref_id: string; title: string; description: string; affected_parks?: string[] | null }> = [];

const KLYU = 'Ключевской — маршруты закрыты на зимний сезон: Передвижение в районах вулканов крайне опасно';
const SEASONAL = 'Маршруты природного парка «Налычево» закрыты на период межсезонья';

function realTour(t: Tour) {
  return {
    tourId: t.tourId, title: t.title, shortDescription: t.shortDescription ?? null,
    operatorName: 'Оператор', operatorSlug: 'op', operatorRating: null, operatorReviewCount: 0,
    operatorVerified: false, tourRating: null, tourReviewCount: 0, basePrice: 20000, priceUnit: 'per_person',
    maxParticipants: 10, minParticipants: 1, durationHours: t.durationHours ?? 10, difficulty: null,
    weatherDependent: false, seasonStart: null, seasonEnd: null, included: t.included ?? null,
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
        const closed = ids.map((id) => ({
          ref_kind: 'tour', ref_id: id, alert_id: 'a-klyu', alert_type: 'park_closure',
          title: 'Природный парк «Ключевской» — маршруты закрыты на зимний сезон',
          description: 'Передвижение в районах вулканов крайне опасно',
          published_iso: '2026-11-12T00:00:00Z', expires_iso: '2099-01-01T00:00:00Z',
        }));
        const extra = PARK_EXTRA.map((row, i) => ({
          ref_kind: 'tour', ref_id: row.ref_id, alert_id: `a-extra-${i}`, alert_type: 'park_closure',
          title: row.title, description: row.description, affected_parks: row.affected_parks ?? null,
          published_iso: '2026-11-12T00:00:00Z', expires_iso: '2099-01-01T00:00:00Z',
        }));
        return { rows: [...extra, ...closed] };
      }
      return { rows: [] };
    }),
  },
}));

import { fetchForecastDays, tripForecastWindow } from '@/lib/planner/intelligence';
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
const ZELEN_BY_TEXT: Tour = {
  tourId: 't-106', title: 'Зеленовские озерки', zone: 'avachinsky', activityType: 'excursion',
  shortDescription: 'Визитная карточка Камчатки — термальные источники Зеленовские озерки.',
  included: ['трансфер', 'купание'],
};

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
  PARK_EXTRA = [];
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
    expect(textSaysSprings(['Зеленовские озерки'])).toBe(false);
    expect(textSaysSprings([
      'Визитная карточка Камчатки — термальные источники Зеленовские озерки.',
      'купание',
    ])).toBe(true);
    expect(outingVarietyKey({ activityType: 'excursion', title: 'Зеленовские озерки', description: 'термальные источники', included: ['купание'] })).toBe('hot_spring');
    expect(outingVarietyKey({ activityType: 'thermal', title: 'Малкинские источники' })).toBe('hot_spring');
    expect(outingVarietyKey({ activityType: 'jeep', title: 'Джип к перевалу', description: 'грунтовая дорога' })).toBe('jeep');
    expect(outingVarietyKey({ activityType: 'helicopter', title: 'Долина гейзеров', description: 'высадка у термальных полей, купание' })).toBe('helicopter');
    expect(outingVarietyKey({ activityType: 'volcano', description: 'термальные поля Мутновского' })).toBe('volcano');
    expect(outingVarietyKey({ activityType: 'jeep', description: 'купание в горячих источниках' })).toBe('jeep');
    expect(varietyKey('rafting')).toBe('river');
    expect(outingVarietyKey({ activityType: 'rafting', title: 'Сплав по Быстрой', description: 'купание у берега' })).toBe('river');
    expect(capSkippedLine('hot_spring')).toMatch(/Ещё полный день на источниках не ставили/);
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

  it('датированные Малки и Зеленовские по описанию: второй полный день источников не встаёт, и фраза про это правдива', async () => {
    const span = Array.from({ length: 11 }, (_, i) => {
      const t = Date.parse(`${iso(11, 24)}T00:00:00Z`) + i * 86_400_000;
      return new Date(t).toISOString().slice(0, 10);
    });
    TOURS = { 'avachinsky:thermal': [MALKI, ZELEN_BY_TEXT] };
    KEEPS = { 't-82': true, 't-106': true };
    SLOTS = { 't-82': span, 't-106': span };
    const rec = await recommendTrip({ ...FAMILY, tripOrigin: 'visitor' }, { itinerary: 'plain' });
    const spring = (d: (typeof rec.days)[number]) => Boolean(d.realTour) && outingVarietyKey({
      activityType: d.realTour?.activityType, title: d.realTour?.title, description: d.realTour?.shortDescription, included: d.realTour?.included,
    }) === 'hot_spring';
    const springDays = rec.days.filter(spring);
    expect(springDays.map((d) => d.realTour?.tourId)).not.toContain('t-106');
    expect(springDays.length).toBeLessThanOrEqual(1);
    for (let i = 1; i < rec.days.length; i++) {
      expect(spring(rec.days[i - 1]!) && spring(rec.days[i]!)).toBe(false);
    }
    const text = warnings(rec);
    expect(text).toMatch(/Ещё полный день на источниках не ставили/);
    expect(text).toMatch(/такой день в поездке обычно один/);
    const arrival = rec.days.find((d) => d.type === 'arrival');
    expect(arrival?.activityType).toBe('arrival');
    const city = rec.days.find((d) => d.title.startsWith('Свободный день. Город'));
    if (city) expect(city.activityType).toBe('city');
    expect(rec.days.some((d) => (d.type === 'arrival' || d.title.startsWith('Свободный день. Город')) && d.activityType === 'hot_spring')).toBe(false);
  });

  it('второй день источников не встаёт в дырку рядом с уже стоящим', () => {
    const days = [
      { day: 1, type: 'arrival', activityType: 'arrival', title: 'Прилёт' },
      { day: 2, type: 'activity', activityType: 'thermal', title: 'Малкинские источники', realTour: { tourId: 't-82', activityType: 'thermal', title: 'Малкинские источники' } },
      { day: 3, type: 'activity', activityType: 'city', title: 'Свободный день. Город, сувениры, рыбный рынок' },
    ];
    const deny = admitsAt(days, 3, 'hot_spring', 't-106', 1, 11);
    expect(deny.ok).toBe(false);
    if (!deny.ok) expect(['cap', 'row']).toContain(deny.kind);
  });

  it('обмен с резервом оставляет номера дней: дыра перед отъездом не закрывается', () => {
    const fc = (precip: number, description: string) => ({
      tempMin: -8, tempMax: -2, precipMm: precip, windKmh: 20, code: precip >= 10 ? 75 : 3, description,
    });
    const days = [
      { day: 1, type: 'arrival', zone: 'avachinsky' as const, title: 'Прилёт', activityType: 'arrival' },
      {
        day: 2, type: 'activity', zone: 'avachinsky' as const, title: 'Малки', activityType: 'thermal',
        realTour: { tourId: 't-82' }, weatherForecast: fc(12, 'Сильный снег'), slotsRemaining: 4, realPrice: 20000,
      },
      { day: 10, type: 'rest', zone: 'avachinsky' as const, title: 'Резервный день на погоду', activityType: 'rest', weatherForecast: fc(1, 'Облачно') },
      { day: 11, type: 'departure', zone: 'avachinsky' as const, title: 'Вылет', activityType: 'departure' },
    ];
    const out = shelterBadOutings(days);
    expect(out.map((d) => d.day)).toEqual([1, 2, 10, 11]);
    expect(out.find((d) => d.day === 11)?.type).toBe('departure');
    expect(out.find((d) => d.day === 10)?.realTour?.tourId).toBe('t-82');
    expect(out.find((d) => d.day === 2)?.title).toBe('Резервный день на погоду');
    expect(out.find((d) => d.day === 2)?.weatherForecast?.description).toBe('Сильный снег');
    expect(out.find((d) => d.day === 10)?.weatherForecast?.description).toBe('Облачно');
    const moved = out.find((d) => d.realTour?.tourId === 't-82');
    expect(moved && 'slotsRemaining' in moved).toBe(false);
    expect(moved && 'realPrice' in moved).toBe(false);
  });
});

describe('плохой день не получает выезд, если есть резерв', () => {
  const kamchatkaIso = (offset: number): string => {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kamchatka', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    return new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
  };

  it('сильный снег на дне выезда меняется с резервным днём', async () => {
    const arrival = kamchatkaIso(1);
    const departure = kamchatkaIso(11);
    const window = tripForecastWindow(arrival, 11);
    expect(window).not.toBeNull();
    const badDate = window!.dates[1]!;
    vi.mocked(fetchForecastDays).mockImplementation(async () => ({
      ok: true,
      days: window!.dates.map((date) => ({
        date, tempMax: -2, tempMin: -8, precipMm: date === badDate ? 12 : 1, windKmh: 20,
        weatherCode: date === badDate ? 75 : 3,
        description: date === badDate ? 'Сильный снег' : 'Облачно',
      })),
    }));
    TOURS = { 'avachinsky:thermal': [MALKI] };
    KEEPS = { 't-82': true };
    SLOTS = { 't-82': [badDate] };
    try {
      const rec = await recommendTrip({
        ...FAMILY, arrivalDate: arrival, departureDate: departure, tripOrigin: 'visitor',
      }, { itinerary: 'plain' });
      const outing = rec.days.find((d) => d.realTour?.tourId === 't-82');
      expect(outing).toBeTruthy();
      expect(outing?.weatherForecast?.precipMm).not.toBe(12);
      expect(outing?.weatherForecast?.description).not.toBe('Сильный снег');
      const snow = rec.days.find((d) => d.weatherForecast?.description === 'Сильный снег');
      expect(snow?.realTour).toBeFalsy();
      expect(snow?.title).toBe('Резервный день на погоду');
    } finally {
      vi.mocked(fetchForecastDays).mockReset();
      vi.mocked(fetchForecastDays).mockResolvedValue({ ok: false, reason: 'test' });
    }
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

  it('сезонная сводка не гасит другое закрытие парка, в любом порядке строк', async () => {
    const seasonal = { title: 'Маршруты природного парка «Налычево» закрыты на период межсезонья', description: '' };
    const storm = { title: 'Маршруты парка закрыты из-за циклона', description: 'Порывы до 32 м/с' };
    for (const alerts of [[seasonal, storm], [storm, seasonal]]) {
      const got = gateClosureFromAlerts(alerts);
      expect(got.operational).toBe(true);
      expect(got.summary).toMatch(/циклон/);
    }
    expect(gateClosureFromAlerts([seasonal]).operational).toBe(false);
    const bare = {
      title: 'Природный парк «Налычево» — маршруты закрыты', description: '',
      alert_id: 'bare', affected_parks: ['nalychevo'],
    };
    const seasonRow = { ...seasonal, alert_id: 'season', affected_parks: ['nalychevo'] };
    for (const pair of [[seasonRow, bare], [bare, seasonRow]]) {
      const covered = gateClosureFromAlerts(pair);
      expect(covered.operational).toBe(false);
      expect(covered.summary).toMatch(/межсезонь/);
      expect(tourGate({
        kind: 'request', youngest: null, activityMinAge: 0, activityName: 'вертолётные экскурсии',
        placeOpenFrom: null, placeOpenTo: null, offOrientation: true, parkClosed: true,
        ageText: '', date: `${Y}-11-24`, parkSummary: covered.summary, operationalClosure: covered.operational,
      })).toBeNull();
    }
    expect(gateClosureFromAlerts([bare]).operational).toBe(true);
    expect(gateClosureFromAlerts([{ ...bare, affected_parks: ['klyuchevskoy'] }, seasonRow]).operational).toBe(true);
    const clipped = { title: `${seasonal.title}${' '.repeat(TITLE_CLIP)}`.slice(0, TITLE_CLIP), description: '' };
    expect(gateClosureFromAlerts([clipped]).operational).toBe(true);
    const gate = tourGate({
      kind: 'request', youngest: null, activityMinAge: 0, activityName: 'вертолётные экскурсии',
      placeOpenFrom: null, placeOpenTo: null, offOrientation: true, parkClosed: true,
      ageText: '', date: `${Y}-11-24`, parkSummary: seasonal.title, operationalClosure: true,
    });
    expect(gate?.reason).toBe('park_and_off_season');
    const plain: Tour = {
      tourId: 't-both', title: 'Налычево без высадки', zone: 'avachinsky', activityType: 'helicopter',
    };
    for (const alerts of [[seasonal, storm], [storm, seasonal]]) {
      PARK_EXTRA = alerts.map((a) => ({ ref_id: 't-both', ...a }));
      TOURS = { 'avachinsky:helicopter': [plain] };
      KEEPS = { 't-both': false };
      const rec = await recommendTrip({
        interests: ['helicopter'],
        arrivalDate: `${Y}-11-24`, departureDate: `${Y}-11-28`,
        adults: 2, children: [], fitnessLevel: 'moderate', budgetTier: 'comfort', travelStyle: 'mixed',
        tripOrigin: 'visitor',
      }, { itinerary: 'plain' });
      expect(tourIds(rec)).not.toContain('t-both');
      expect(warnings(rec)).toMatch(/Налычево без высадки[\s\S]{0,200}парк у места тура закрыт по сводке/);
    }
    const bareAlert = {
      ref_id: 't-both', title: bare.title, description: '', affected_parks: ['nalychevo'] as string[],
    };
    const seasonAlert = {
      ref_id: 't-both', title: seasonRow.title ?? '', description: '', affected_parks: ['nalychevo'] as string[],
    };
    for (const alerts of [[bareAlert, seasonAlert], [seasonAlert, bareAlert]]) {
      PARK_EXTRA = alerts;
      TOURS = { 'avachinsky:helicopter': [plain] };
      KEEPS = { 't-both': false };
      const rec = await recommendTrip({
        interests: ['helicopter'],
        arrivalDate: `${Y}-11-24`, departureDate: `${Y}-11-28`,
        adults: 2, children: [], fitnessLevel: 'moderate', budgetTier: 'comfort', travelStyle: 'mixed',
        tripOrigin: 'visitor',
      }, { itinerary: 'plain' });
      expect(tourIds(rec)).toContain('t-both');
      expect(warnings(rec)).not.toMatch(/Налычево без высадки[\s\S]{0,120}закрыт по сводке/);
    }
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
