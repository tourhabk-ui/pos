/**
 * Погода и «план Б» на публичном плане («Мой план 2.0», B-5; владелец:
 * «действуй»).
 *
 * План перестаёт быть картинкой: у дня — прогноз Open-Meteo по его
 * координатам (только в горизонте 16 суток), а у погодозависимого тура при
 * плохом прогнозе — запасные варианты. «План Б» — не сочинение модели:
 * запасные туры заводят операторы в contingency_rules; триггер
 * детерминированный (ветер ≥ 40 км/ч или осадки ≥ 10 мм).
 * Ни у одного из 84 планировщиков TAAFT этого нет.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  readSharedPlan: vi.fn(),
  toursByIds: vi.fn(),
  fetchForecastDays: vi.fn(),
  fetchContingencyAlternatives: vi.fn(),
}));
vi.mock('@/lib/trips/shared-plan', () => ({ readSharedPlan: m.readSharedPlan }));
vi.mock('@/lib/tours/top-tour-by-activity', () => ({ toursByIds: m.toursByIds, topToursByActivity: async () => ({}) }));
vi.mock('@/lib/planner', () => ({
  createPlannerCache: () => new Map(),
  fetchAvailabilityForTour: async () => [{ remaining: 5 }],
  fetchForecastDays: m.fetchForecastDays,
  fetchContingencyAlternatives: m.fetchContingencyAlternatives,
}));
vi.mock('@/lib/seat-requests/service', () => ({ tourKeepsSchedule: async () => true }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));

import { GET } from '@/app/api/trips/share/[token]/route';

const ROOT = process.cwd();
const SHARE_UI = readFileSync(join(ROOT, 'app/trip/[token]/_TripShareClient.tsx'), 'utf-8');
const RESOLVER = readFileSync(join(ROOT, 'lib/tours/top-tour-by-activity.ts'), 'utf-8');

// Страница плана по ссылке — вызовом её роута (правило мест и прогноза с 19.11
// живёт в lib/trips/day-fresh, одно с перепроверкой поездки в кабинете, #3394).
const TOKEN = '00000000-0000-4000-8000-000000000614';
const isoIn = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const ARRIVAL = isoIn(3);
const dayDate = (n: number) => new Date(Date.parse(`${ARRIVAL}T00:00:00Z`) + (n - 1) * 86_400_000).toISOString().slice(0, 10);
const day = (n: number) => ({ day: n, type: 'activity', zone: 'avachinsky', title: `День ${n}`, activityType: 'volcano', coords: [53.01, 158.65] });
const tour = (id: string, weatherDependent: boolean) => ({
  id, slug: null, title: `Тур ${id}`, base_price: '15000', operator_name: 'Оператор', operator_slug: null,
  operator_public: false, weather_dependent: weatherDependent,
});
const sharedPlan = (days: number[], tours: Record<number, string>) => ({
  kind: 'found',
  plan: {
    source: 'trip', id: 't1', title: 'План', arrival_date: ARRIVAL, departure_date: dayDate(Math.max(...days)),
    places: [], activities: [], transport_by_day: {}, days: days.map(day), day_tour_ids: tours, people: 1,
  },
});
const forecastDay = (date: string, over: Record<string, unknown> = {}) => ({
  date, tempMax: 4.4, tempMin: -2.6, precipMm: 0.2, windKmh: 12.3, weatherCode: 3, description: 'облачно', ...over,
});
type ShareData = {
  weather: Record<string, { date: string; tempMin: number; tempMax: number; windKmh: number; precipMm: number; description: string; bad: boolean }>;
  plan_b: Record<string, Array<{ tour_id: string; title: string }>>;
};
const share = async (): Promise<{ status: number; data: ShareData }> => {
  const res = await GET(new NextRequest(`http://x/api/trips/share/${TOKEN}`), { params: Promise.resolve({ token: TOKEN }) });
  return { status: res.status, data: (await res.json() as { data: ShareData }).data };
};

describe('B-5: погода в дне плана — вызовом роута', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    m.toursByIds.mockResolvedValue({ 70: tour('70', true) });
    m.fetchContingencyAlternatives.mockResolvedValue([]);
  });
  afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

  it('прогноз — из движка, округлён и только в горизонте 16 суток; дальний день прогноза не спрашивает', async () => {
    // День 1 — через 3 суток, день 20 — через 22: вне горизонта Open-Meteo.
    m.readSharedPlan.mockResolvedValue(sharedPlan([1, 20], {}));
    m.fetchForecastDays.mockImplementation(async () => ({ ok: true, days: [forecastDay(dayDate(1))] }));
    const { status, data } = await share();
    expect(status).toBe(200);
    expect(data.weather['1']).toEqual({
      date: dayDate(1), tempMin: -3, tempMax: 4, windKmh: 12, precipMm: 0, description: 'облачно', bad: false,
    });
    expect(data.weather['20']).toBeUndefined();
    expect(m.fetchForecastDays).toHaveBeenCalledTimes(1);
  });

  it('неполный день прогноза не показывается нулями', async () => {
    m.readSharedPlan.mockResolvedValue(sharedPlan([1], {}));
    m.fetchForecastDays.mockResolvedValue({ ok: true, days: [forecastDay(dayDate(1), { windKmh: null })] });
    expect((await share()).data.weather).toEqual({});
  });

  it('порог «плохой погоды» детерминированный: ветер ≥ 40 или осадки ≥ 10', async () => {
    m.readSharedPlan.mockResolvedValue(sharedPlan([1, 2, 3, 4], {}));
    m.fetchForecastDays.mockResolvedValue({ ok: true, days: [
      forecastDay(dayDate(1), { windKmh: 40 }),
      forecastDay(dayDate(2), { windKmh: 39.9, precipMm: 9.9 }),
      forecastDay(dayDate(3), { precipMm: 10 }),
      forecastDay(dayDate(4)),
    ] });
    const { weather } = (await share()).data;
    expect([1, 2, 3, 4].map((n) => weather[String(n)]?.bad)).toEqual([true, false, true, false]);
  });

  it('клиент показывает прогноз и подсвечивает плохую погоду warning-цветом', () => {
    expect(SHARE_UI).toMatch(/Прогноз на \{shortDate\(w\.date\)\}/);
    expect(SHARE_UI).toMatch(/w\.bad \? 'var\(--warning\)'/);
  });
});

describe('B-5: «план Б» при непогоде', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    m.fetchContingencyAlternatives.mockResolvedValue([
      { tourId: '81', slug: 'a', title: 'Запасной 1' }, { tourId: '82', slug: null, title: 'Запасной 2' },
      { tourId: '83', slug: null, title: 'Запасной 3' },
    ]);
  });
  afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

  it('только для погодозависимых туров при плохом прогнозе и только из contingency_rules операторов', async () => {
    // День 1 — погодозависимый тур, плохо; день 2 — не погодозависимый, плохо;
    // день 3 — погодозависимый, хорошо.
    m.readSharedPlan.mockResolvedValue(sharedPlan([1, 2, 3], { 1: '70', 2: '71', 3: '72' }));
    m.toursByIds.mockResolvedValue({ 70: tour('70', true), 71: tour('71', false), 72: tour('72', true) });
    m.fetchForecastDays.mockResolvedValue({ ok: true, days: [
      forecastDay(dayDate(1), { windKmh: 55 }), forecastDay(dayDate(2), { windKmh: 55 }), forecastDay(dayDate(3)),
    ] });
    const { plan_b } = (await share()).data;
    expect(Object.keys(plan_b)).toEqual(['1']);
    expect(plan_b['1'].map((a) => a.tour_id)).toEqual(['81', '82']);
    expect(m.fetchContingencyAlternatives).toHaveBeenCalledTimes(1);
    expect(m.fetchContingencyAlternatives.mock.calls[0][0]).toBe('70');
    // Признак погодозависимости — из записи тура, без выдуманного «да».
    expect(RESOLVER).toMatch(/COALESCE\(ot\.weather_dependent, FALSE\) AS weather_dependent/);
  });

  it('клиент рендерит запасные туры ссылками на бронь', () => {
    expect(SHARE_UI).toMatch(/План Б при непогоде/);
    expect(SHARE_UI).toMatch(/tourPath\(\{ id: a\.tour_id, slug: a\.slug \}\)/);
  });

  it('все сбои — блока нет, план жив, причина в логе', async () => {
    m.readSharedPlan.mockResolvedValue(sharedPlan([1, 2], { 1: '70', 2: '70' }));
    m.toursByIds.mockResolvedValue({ 70: tour('70', true) });
    // День 1: прогноз упал; день 2: прогноз плохой, запасные туры не прочитались.
    m.fetchForecastDays.mockImplementation(async () => { throw new Error('open-meteo 502'); });
    let r = await share();
    expect(r.status).toBe(200);
    expect(r.data.weather).toEqual({});
    m.fetchForecastDays.mockReset();
    m.fetchForecastDays.mockResolvedValue({ ok: true, days: [forecastDay(dayDate(2), { windKmh: 60 })] });
    m.fetchContingencyAlternatives.mockRejectedValue(Object.assign(new Error('db'), { code: '57014' }));
    r = await share();
    expect(r.status).toBe(200);
    expect(r.data.weather['2']?.bad).toBe(true);
    expect(r.data.plan_b).toEqual({});
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('план Б на день не прочитан'), '57014');
  });
});
