/**
 * PDF владельца 23.11 (план 24.11–04.12, 2 взрослых + дети 5/11/17) — регресс
 * на движке (`recommendTrip` на подменённом хранилище, без LLM и без ПД):
 *   1) вертолёт на Толбачик без календаря 1 декабря при закрытом по сводке
 *      парке и «не сезон» по ориентиру — в план не встаёт, и это сказано;
 *      без закрытия парка правило 08.10 («месяц открывает тур без
 *      календаря») прежнее — тур встаёт;
 *   2) день тура с местом в другой зоне показывает зону места, а прогноз
 *      берётся по точке места;
 *   3) день без тура — «День на своё усмотрение»;
 *   4) пустой день занимает тур с выездом в календаре (облёты 24–30.11),
 *      в т. ч. обменом с днём отдыха;
 *   5) сводка «День 8: …» и та же строка дня — в блоке безопасности один раз;
 *   6) «ночуете дома» называет выбор «Живу на Камчатке»;
 *   7) ссылка места в PDF — кликабельная и короткая.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Tour {
  tourId: string; title: string; zone: string; activityType: string; durationHours?: number;
  lat?: number; lng?: number; coordsKnown?: boolean; seasonStart?: string | null; seasonEnd?: string | null;
  shortDescription?: string | null; slug?: string | null;
  place?: { name: string; zone: string | null; lat: number | null; lng: number | null; openFrom?: string | null; openTo?: string | null } | null;
}
let TOURS: Record<string, Tour[]> = {};
let KEEPS: Record<string, boolean | null> = {};
let SLOTS: Record<string, string[]> = {};
let PARK_CLOSED = new Set<string>();
let MUSEUM_ROWS: Array<Record<string, string | null>> = [];
const forecastAt: Array<[number, number]> = [];

function realTour(t: Tour) {
  return {
    tourId: t.tourId, title: t.title, shortDescription: null,
    operatorName: 'Оператор', operatorSlug: 'op', operatorRating: null, operatorReviewCount: 0,
    operatorVerified: false, tourRating: null, tourReviewCount: 0, basePrice: 20000, priceUnit: 'per_person',
    maxParticipants: 10, minParticipants: 1, durationHours: t.durationHours ?? 10, difficulty: null,
    weatherDependent: false, seasonStart: t.seasonStart ?? null, seasonEnd: t.seasonEnd ?? null, included: null,
    shortDescription: t.shortDescription ?? null, slug: t.slug ?? null,
    lat: t.lat ?? 53, lng: t.lng ?? 158, coordsKnown: t.coordsKnown ?? true, zone: t.zone, activityType: t.activityType,
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
  fetchActivitiesBookableInMonth: vi.fn(async () => new Set(['helicopter'])),
  fetchActivitiesOnRequest: vi.fn(async () => new Set(['hot_spring', 'helicopter'])),
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
  return { ...real, fetchForecastDays: vi.fn(async (lat: number, lng: number) => { forecastAt.push([lat, lng]); return { ok: false, reason: 'test' }; }) };
});
vi.mock('@/lib/ai/providers', () => ({ callAIWithModelDirect: vi.fn(async () => '') }));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => null }));

/** Закрытие парка «Ключевской» — строкой сводки, как на проде 23.11 (только туру из PARK_CLOSED). */
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('111.0 * sqrt')) return { rows: MUSEUM_ROWS };
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

import { recommendTrip, type TripProfile } from '@/lib/planner/engine';
import { NO_TOUR_DAY_TITLE } from '@/lib/planner/honest-days';
import { safetyBlock } from '@/lib/planner/day-card-view';
import { HOME_NIGHTS_ASSUMPTION } from '@/lib/planner/trip-origin';
import { shortLinkText } from '@/lib/planner/print-html';
import { placeCardFromDetail } from '@/lib/planner/day-place-cards';

const Y = new Date().getUTCFullYear() + 1;
const iso = (m: number, d: number) => `${Y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const NOV = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => iso(11, from + i));
const CASE: TripProfile = {
  interests: ['hot_spring', 'helicopter', 'geyser', 'snowmobile', 'fishing'],
  arrivalDate: iso(11, 24), departureDate: iso(12, 4),
  adults: 2, children: [5, 11, 17], fitnessLevel: 'moderate', budgetTier: 'comfort', travelStyle: 'mixed', restDays: 2,
};
const THERMAL5: Tour = { tourId: 't-thermal5', title: 'Камчатка: термальный маршрут', zone: 'avachinsky', activityType: 'hot_spring', durationHours: 5 * 24 };
const TOLBACHIK: Tour = {
  tourId: 't-tolb', title: 'Вулкан Толбачик (вертолёт)', zone: 'avachinsky', activityType: 'helicopter', durationHours: 7,
  lat: 55.83, lng: 160.33, place: { name: 'Вулкан Толбачик', zone: 'northern', lat: 55.818, lng: 160.39 },
};
const MUT: Tour = { tourId: 't-mut', title: 'Облёт вулканов Мутновский и Горелый', zone: 'avachinsky', activityType: 'helicopter', durationHours: 3 };
const AVA: Tour = { tourId: 't-ava', title: 'Облёт Авачинской бухты и Авачинского вулкана', zone: 'avachinsky', activityType: 'helicopter', durationHours: 3 };

beforeEach(() => {
  TOURS = { 'avachinsky:hot_spring': [THERMAL5], 'avachinsky:helicopter': [TOLBACHIK, MUT, AVA] };
  KEEPS = { 't-thermal5': false, 't-tolb': false, 't-mut': true, 't-ava': true };
  SLOTS = { 't-mut': NOV(24, 30), 't-ava': NOV(24, 30) };
  PARK_CLOSED = new Set(['t-tolb']);
  MUSEUM_ROWS = [];
  forecastAt.length = 0;
});

const tourIds = (rec: Awaited<ReturnType<typeof recommendTrip>>) => rec.days.map((d) => d.realTour?.tourId).filter(Boolean);
const text = (rec: Awaited<ReturnType<typeof recommendTrip>>) => rec.warnings.map((w) => w.message).join('\n');

describe('PDF владельца 24.11–04.12 (23.11)', () => {
  for (const origin of ['visitor', 'local'] as const) {
    it(`${origin}: Толбачик при закрытом парке и «не сезон» не встаёт; облёты с выездами заняли пустые дни`, async () => {
      const rec = await recommendTrip({ ...CASE, tripOrigin: origin }, { itinerary: 'plain' });
      expect(tourIds(rec)).not.toContain('t-tolb');
      // Приезжему тур пробовали поставить — и сказано, почему нет; местному
      // вертолётные дни заняли облёты с выездами раньше, чем дошло до Толбачика.
      if (origin === 'visitor') expect(text(rec)).toMatch(/Не ставили: «Вулкан Толбачик \(вертолёт\)» — по нашему сезонному ориентиру в ваши даты не сезон, парк у места тура закрыт по сводке/);
      expect(tourIds(rec)).toContain('t-mut');
      // Каждый поставленный облёт — в день с выездом в календаре.
      for (const d of rec.days.filter((x) => x.realTour?.tourId === 't-mut' || x.realTour?.tourId === 't-ava')) {
        expect(d.realTour?.calendar).toBe('dated');
        expect(d.availability).toBe('open');
        expect(SLOTS[d.realTour!.tourId]).toContain(d.availableDate);
      }
      if (origin === 'local') expect(tourIds(rec)).toContain('t-ava');
      // Пустого дня с летним туром нет, и старого заголовка тоже.
      expect(rec.days.map((d) => d.title)).not.toContain('Подходящего тура на эти даты нет');
      expect(rec.days.every((d) => !d.title.startsWith('Подходящего тура'))).toBe(true);
      expect(rec.days.filter((d) => d.title === NO_TOUR_DAY_TITLE).length).toBeLessThanOrEqual(1);
    });
  }

  it('без закрытия парка правило 08.10 прежнее: тур без календаря встаёт, зона и прогноз — по месту', async () => {
    PARK_CLOSED = new Set();
    TOURS['avachinsky:helicopter'] = [TOLBACHIK];
    const rec = await recommendTrip({ ...CASE, tripOrigin: 'local' }, { itinerary: 'plain' });
    const day = rec.days.find((d) => d.realTour?.tourId === 't-tolb');
    expect(day, 'Толбачик не встал').toBeDefined();
    expect(day!.zone).toBe('avachinsky');
    expect(day!.zoneShown).toBe('northern');
    // Прогноз дня берётся по этой точке (даты теста за горизонтом прогноза —
    // сам запрос здесь не делается).
    expect(day!.weatherPoint).toEqual([55.818, 160.39]);
  });

  it('пустой день ноября занимает место каталога со slug, а не выдуманную прогулку', async () => {
    TOURS = {};
    MUSEUM_ROWS = [{ id: '1', slug: 'kraevedchesky-muzey', ark_id: null, name: 'Краеведческий музей', location_type: 'museum', lat: '53.02', lng: '158.65' }];
    const rec = await recommendTrip({ ...CASE, interests: ['helicopter'], tripOrigin: 'local' }, { itinerary: 'plain' });
    const self = rec.days.filter((d) => d.title.startsWith('Самостоятельно:'));
    expect(self.length).toBeGreaterThan(0);
    expect(self.every((d) => d.placeHref === '/places/kraevedchesky-muzey')).toBe(true);
    expect(rec.days.every((d) => !d.title.startsWith('Подходящего тура'))).toBe(true);
    expect(JSON.stringify(rec.days)).not.toContain('98d0607d');
  });

  it('день без тура — нормальный заголовок', () => {
    expect(NO_TOUR_DAY_TITLE).toBe('День на своё усмотрение');
  });

  it('место подписано авачинским, а точка — Толбачик: зона и погода по координате', async () => {
    PARK_CLOSED = new Set();
    TOURS['avachinsky:helicopter'] = [{
      ...TOLBACHIK,
      place: { name: 'Вулкан Толбачик', zone: 'avachinsky', lat: 55.818, lng: 160.39 },
    }];
    const rec = await recommendTrip({ ...CASE, tripOrigin: 'local' }, { itinerary: 'plain' });
    const day = rec.days.find((d) => d.realTour?.tourId === 't-tolb');
    expect(day, 'Толбачик не встал').toBeDefined();
    expect(day!.zoneShown).toBe('northern');
    expect(day!.weatherPoint).toEqual([55.818, 160.39]);
  });

  it('окно места закрыто на ноябрь — тур без календаря не встаёт', async () => {
    PARK_CLOSED = new Set();
    TOURS['avachinsky:helicopter'] = [{
      ...TOLBACHIK,
      place: { name: 'Вулкан Толбачик', zone: 'northern', lat: 55.818, lng: 160.39, openFrom: `${Y}-06-01`, openTo: `${Y}-09-30` },
    }];
    const rec = await recommendTrip({ ...CASE, tripOrigin: 'visitor' }, { itinerary: 'plain' });
    expect(tourIds(rec)).not.toContain('t-tolb');
    expect(text(rec)).toMatch(/Не ставили: «Вулкан Толбачик \(вертолёт\)» — дата вне окна, когда место открыто по карточке места/);
  });

  it('в тексте тура «от 12 лет», в группе ребёнок 5 лет — тур не встаёт', async () => {
    PARK_CLOSED = new Set();
    TOURS['avachinsky:helicopter'] = [{ ...TOLBACHIK, shortDescription: 'Облёт вулкана, программа от 12 лет' }];
    const rec = await recommendTrip({ ...CASE, tripOrigin: 'visitor' }, { itinerary: 'plain' });
    expect(tourIds(rec)).not.toContain('t-tolb');
    expect(text(rec)).toMatch(/ребёнок 5 лет/);
    expect(text(rec)).toMatch(/от 12 лет/);
  });
});

describe('PDF: безопасность, допущение о доме, ссылки', () => {
  it('«День 8: X» в сводке и X на дне 8 — одна строка с днём', () => {
    const X = 'Закрытие парка по сводке от 12.11: «Природный парк «Ключевской» — маршруты закрыты на зимний сезон». Перед выходом уточните у дирекции парка.';
    const items = safetyBlock(
      [{ day: 8, type: 'activity', title: 'Толбачик', dayWarnings: [X] }],
      [{ type: 'safety', severity: 'critical', message: `День 8: ${X}` }],
    );
    const same = items.filter((it) => it.text === X);
    expect(same).toHaveLength(1);
    expect(same[0].days).toEqual([8]);
    expect(same[0].severity).toBe('critical');
  });

  it('точка и хвост в конце строки не делают вторую запись', () => {
    const base = 'Закрытие парка по сводке от 12.11: маршруты природного парка закрыты на зимний сезон';
    const items = safetyBlock(
      [{ day: 8, type: 'activity', title: 'Толбачик', dayWarnings: [`${base}.`] }],
      [{ type: 'safety', severity: 'important', message: `${base} Перед выходом уточните у дирекции.` }],
    );
    expect(items.filter((it) => it.text.includes('маршруты природного парка'))).toHaveLength(1);
  });

  it('«ночуете дома» называет выбор и путь к «Прилетаю»', () => {
    expect(HOME_NIGHTS_ASSUMPTION).toMatch(/Вы выбрали «Живу на Камчатке»/);
    expect(HOME_NIGHTS_ASSUMPTION).toMatch(/выберите «Прилетаю»/);
    expect(HOME_NIGHTS_ASSUMPTION).not.toMatch(/ночуете у себя/);
  });

  it('ссылка места: slug, если записан; UUID — словами, а не рваным адресом', () => {
    expect(shortLinkText('https://vedarai.ru/places/98d0607d-8547-40a3-8b71-e981b59a31df')).toBe('страница места на vedarai.ru');
    expect(shortLinkText('https://vedarai.ru/places/paratunka')).toBe('vedarai.ru/places/paratunka');
    expect(shortLinkText('https://vedarai.ru/catalog/tours/112')).toBe('vedarai.ru/catalog/tours/112');
    const card = placeCardFromDetail({ id: '98d0607d-8547-40a3-8b71-e981b59a31df', slug: 'paratunka', name: 'Паратунская зона отдыха' });
    expect(card?.href).toBe('/places/paratunka');
    const noSlug = placeCardFromDetail({ id: '98d0607d-8547-40a3-8b71-e981b59a31df', name: 'Паратунская зона отдыха' });
    expect(noSlug?.href).toBe('/places/98d0607d-8547-40a3-8b71-e981b59a31df');
  });
});
