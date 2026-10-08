// @vitest-environment node
/**
 * Погода экрана безопасности — тот же прогноз, что у Кузьмича и /weather
 * (решение владельца 08.10: «перевести на наш прогноз»).
 *
 * До этого /safety и /hub/safety брали «текущие условия» wttr.in — третьего
 * сервиса погоды на платформе: турист видел на радаре одно, у Кузьмича и на
 * странице погоды — другое. Теперь «сейчас» — прогноз текущей части дня по
 * часам Камчатки, и подписан прогнозом, а не замером.
 *
 * Сторож держит:
 * 1. часть дня выбирается по часу Камчатки той же таблицей, что собирает части;
 * 2. строки — правилами weather-format, пропуск не становится нулём;
 * 3. время — момент получения прогноза, старый прогноз помечен;
 * 4. роут: тот же горизонт, что у /weather (общая запись кэша), отказ — 502.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const { fetchForecastDays } = vi.hoisted(() => ({ fetchForecastDays: vi.fn() }));
vi.mock('@/lib/planner/intelligence', async (orig) => ({
  ...(await orig<typeof import('@/lib/planner/intelligence')>()),
  fetchForecastDays,
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));

import { dayPartForHour } from '@/lib/weather/day-parts';
import { safetyWeather } from '@/lib/weather/safety-widget';
import { WEATHER_PAGE_DAYS } from '@/lib/weather/weather-page';
import { DEFAULT_WEATHER_PLACE } from '@/lib/kuzmich/weather-tool';
import { GET } from '@/app/api/safety/weather/route';
import type { ForecastDay } from '@/lib/planner/intelligence';

afterEach(() => { fetchForecastDays.mockReset(); vi.restoreAllMocks(); });

const TODAY: ForecastDay = {
  date: '2026-10-08', tempMin: 2, tempMax: 7.1, precipMm: 0.8, windKmh: 45.3, weatherCode: 85, description: 'Снегопад',
  parts: [
    { label: 'ночь', precipMm: 0, snowCm: 0, tempMin: 2, tempMax: 3, windKmh: 30 },
    { label: 'утро', precipMm: 0.5, snowCm: 0.3, tempMin: -1, tempMax: 0.4, windKmh: 40 },
    { label: 'день', precipMm: 0.3, snowCm: 0, tempMin: 5, tempMax: 7, windKmh: 45 },
    { label: 'вечер', precipMm: null, snowCm: null, tempMin: null, tempMax: null, windKmh: null },
  ],
};
const OK = { ok: true as const, days: [TODAY], fetchedAt: '2026-10-08T00:05:00.000Z' };
// 01:00 UTC = 13:00 по Камчатке (UTC+12).
const NOON = new Date('2026-10-08T01:00:00Z');

describe('часть дня по часу Камчатки', () => {
  it('границы — те же, что у сборки частей', () => {
    expect([0, 5, 6, 11, 12, 17, 18, 23].map(dayPartForHour))
      .toEqual(['ночь', 'ночь', 'утро', 'утро', 'день', 'день', 'вечер', 'вечер']);
  });
});

describe('ответ виджета', () => {
  it('днём — прогноз на день и сутки целиком, строками weather-format', () => {
    expect(safetyWeather(OK, 'Петропавловск-Камчатский', NOON)).toEqual({
      place: 'Петропавловск-Камчатский',
      now: { label: 'день', temp: '+5…+7°', precip: 'дождь 0,3 мм', wind: 'ветер до 13 м/с' },
      today: { temp: '+2…+7°', precip: 'осадки 0,8 мм', wind: 'ветер до 13 м/с', sky: null },
      checked_at: '2026-10-08T00:05:00.000Z',
      stale: false,
    });
  });

  it('вечером без данных — «нет данных», а не ноль и не «без осадков»', () => {
    const evening = new Date('2026-10-08T08:30:00Z'); // 20:30 по Камчатке
    expect(safetyWeather(OK, 'x', evening)?.now).toEqual({
      label: 'вечер', temp: null, precip: 'осадки — нет данных', wind: 'ветер — нет данных',
    });
  });

  it('небо сухого дня — словами; при осадках подпись «худшее за сутки» не показывается', () => {
    const dry = { ...OK, days: [{ ...TODAY, precipMm: 0, weatherCode: 3, description: 'Пасмурно' }] };
    expect(safetyWeather(dry, 'x', NOON)?.today.sky).toBe('пасмурно');
  });

  it('источник молчит — старый прогноз помечен, время — когда он получен', () => {
    const stale = { ...OK, staleSince: '2026-10-07T22:00:00.000Z' };
    expect(safetyWeather(stale, 'x', NOON)).toMatchObject({ stale: true, checked_at: '2026-10-07T22:00:00.000Z' });
  });

  it('сегодняшнего дня в прогнозе нет — ответа нет, «сейчас» по вчера не выдумывается', () => {
    expect(safetyWeather({ ...OK, days: [{ ...TODAY, date: '2026-10-07' }] }, 'x', NOON)).toBeNull();
  });
});

describe('роут /api/safety/weather', () => {
  it('город, тот же горизонт, что у /weather, — одна запись кэша на двоих', async () => {
    fetchForecastDays.mockResolvedValue({ ...OK, days: [{ ...TODAY, date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kamchatka' }).format(new Date()) }] });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.place).toBe(DEFAULT_WEATHER_PLACE.name);
    expect(body).toHaveProperty('today.precip', 'осадки 0,8 мм');
    expect(fetchForecastDays).toHaveBeenCalledWith(DEFAULT_WEATHER_PLACE.lat, DEFAULT_WEATHER_PLACE.lng, WEATHER_PAGE_DAYS);
  });

  it('прогноз не получен — 502 со словами, а не пустая погода', async () => {
    fetchForecastDays.mockResolvedValue({ ok: false, reason: 'Open-Meteo HTTP 429' });
    const res = await GET();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Прогноз погоды получить не удалось' });
  });

  it('прогноз кончился вчера — 502 и строка в логе', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchForecastDays.mockResolvedValue({ ...OK, days: [{ ...TODAY, date: '2020-01-01' }] });
    expect((await GET()).status).toBe(502);
    expect(String(spy.mock.calls[0]?.[0])).toMatch(/нет сегодняшнего дня/);
  });
});
