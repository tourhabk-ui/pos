/**
 * Что взять в день плана по прогнозу (#3394, п.6, слово владельца 19.11 «2 да»).
 *
 * Прогноз к дням плана движок получал и раньше (`weatherForecast`), но
 * человек его не видел: поле уходило только в промпт модели. Сторож держит
 * связку вызовом: правило строки (lib/planner/weather-kit) на граничных
 * прогнозах; настоящий recommendTrip — строка у дня в пределах прогноза, за
 * горизонтом её нет, прогноз спрошен по зоне самого дня; и ответ Кузьмича/MCP
 * (formatTripPlanForChat) её печатает.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fc = vi.hoisted(() => ({ calls: [] as Array<[number, number]>, rain: 6 }));

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('@/lib/safety/active-warnings', () => ({
  loadActiveWarnings: vi.fn(async () => ({ ok: true as const, warnings: [] })),
}));
vi.mock('@/lib/planner/data', () => ({
  createPlannerCache: () => new Map(),
  fetchRealToursForZone: vi.fn(async () => []),
  fetchAvailabilityForTour: vi.fn(async () => []),
  fetchZoneCapacity: vi.fn(async () => ({ tourCount: 0, totalSlots: 0, totalBooked: 0, utilizationPercent: 0 })),
  fetchContingencyAlternatives: vi.fn(async () => []),
  fetchReviewSignals: vi.fn(async () => null),
  fetchActivitiesBookableInMonth: vi.fn(async () => new Set<string>(['volcano'])),
  fetchActivitiesOnRequest: vi.fn(async () => new Set<string>()),
  fetchTourKeepsSchedule: vi.fn(async () => false),
  fetchSelfSafety: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/planner/place-load', () => ({
  fetchCandidateLoads: vi.fn(async () => new Map()),
  fetchTourLoads: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/planner/intelligence', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/planner/intelligence')>();
  return {
    ...real,
    // Прогноз на два дня от сегодняшнего по Камчатке — дальше горизонта нет.
    fetchForecastDays: vi.fn(async (lat: number, lng: number) => {
      fc.calls.push([lat, lng]);
      const today = new Date(Date.now() + 12 * 3_600_000).toISOString().slice(0, 10);
      const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
      return {
        ok: true as const,
        days: [0, 1].map((n) => ({
          date: day(n), tempMax: 7, tempMin: 1, precipMm: fc.rain, windKmh: 54, weatherCode: 61, description: 'Дождь',
        })),
      };
    }),
  };
});
vi.mock('@/lib/ai/providers', () => ({ callAIWithModelDirect: vi.fn(async () => 'Пересказ плана.') }));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => 'test-model' }));

import { weatherKitLine } from '@/lib/planner/weather-kit';
import { recommendTrip, ZONE_COORDS, type TripProfile } from '@/lib/planner/engine';
import { formatTripPlanForChat } from '@/lib/kuzmich/trip-plan-tool';

describe('строка «что взять» по прогнозу', () => {
  it('дождь, ветер, холодная ночь — дождевик, ветрозащита, тёплый слой; подъём — про вершину', () => {
    const line = weatherKitLine({ tempMax: 7, tempMin: 1, precipMm: 6, windKmh: 54, code: 61, description: 'Дождь' }, 'volcano');
    expect(line).toBe('Прогноз для зоны дня: Дождь, +1…+7 °C, осадки 6 мм, ветер до 15 м/с. '
      + 'Возьмите дождевик и непромокаемую обувь, ветрозащитную куртку, тёплый слой — флис или пуховку, шапку и перчатки. '
      + 'На вершине холоднее прогноза: около 6,5 °C на каждый километр подъёма.');
  });

  it('тепло и ясно — защита от солнца; снег — обувь от снега; тихо и тепло — без «Возьмите»', () => {
    expect(weatherKitLine({ tempMax: 24, tempMin: 12, precipMm: 0, windKmh: 10, code: 0, description: 'Ясно' }))
      .toBe('Прогноз для зоны дня: Ясно, +12…+24 °C, без осадков, ветер до 3 м/с. Возьмите солнцезащитный крем, очки и головной убор.');
    expect(weatherKitLine({ tempMax: -3, tempMin: -9, precipMm: 4, windKmh: 20, code: 73, description: 'Снег' }))
      .toContain('Возьмите непромокаемую обувь и гамаши от снега, тёплый слой');
    expect(weatherKitLine({ tempMax: 16, tempMin: 9, precipMm: 0, windKmh: 12, code: 3, description: 'Пасмурно' }))
      .toBe('Прогноз для зоны дня: Пасмурно, +9…+16 °C, без осадков, ветер до 3 м/с.');
  });

  it('пустое значение — строки нет, а не нулевой «штиль»', () => {
    expect(weatherKitLine({ tempMax: Number.NaN, tempMin: 1, precipMm: 0, windKmh: 10, code: 0, description: 'Ясно' })).toBeNull();
  });
});

describe('движок и ответ Кузьмича', () => {
  beforeEach(() => { fc.calls.length = 0; fc.rain = 6; });
  const today = new Date(Date.now() + 12 * 3_600_000).toISOString().slice(0, 10);
  const plus = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const PROFILE: TripProfile = {
    interests: ['volcano'], arrivalDate: plus(0), departureDate: plus(4),
    adults: 2, children: [], fitnessLevel: 'active', budgetTier: 'comfort', tripOrigin: 'local',
  };

  it('строка — у дней в пределах прогноза, за горизонтом её нет; прогноз — по зоне дня', async () => {
    const rec = await recommendTrip(PROFILE, { itinerary: 'plain' });
    const withKit = rec.days.filter((d) => d.weatherKit);
    expect(withKit.map((d) => d.day)).toEqual(rec.days.filter((d) => d.day <= 2).map((d) => d.day));
    expect(withKit[0]!.weatherKit).toMatch(/^Прогноз для зоны дня: Дождь, \+1…\+7 °C, осадки 6 мм, ветер до 15 м\/с\. Возьмите дождевик/);
    // Прогноз спрошен точкой зоны каждого дня, не одной точкой поездки.
    const zones = [...new Set(rec.days.map((d) => d.zone))];
    expect(fc.calls).toEqual(zones.map((z) => [ZONE_COORDS[z][0], ZONE_COORDS[z][1]]));

    const text = formatTripPlanForChat(rec.days, [], null, { refusal: '', plannedFor: plus(0), arrivalIso: plus(0) });
    // С 21.11: на дне — короткая строка погоды, совет по одежде — один раз в блоке.
    expect(text).toContain('   Погода: 1…7 °C, дождь');
    expect(text).toMatch(/Безопасность и разрешения:[\s\S]*- Одежда по прогнозу: возьмите дождевик/);
    expect(text.match(/Одежда по прогнозу/g)).toHaveLength(1);
  });
});
