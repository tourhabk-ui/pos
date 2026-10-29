// @vitest-environment node
/**
 * Прогноз Open-Meteo — один путь (#2289, п. 2; решение владельца 29.10).
 *
 * Пять мест звали Open-Meteo сами, мимо общего `fetchForecastDays`, у
 * которого осадки из GFS (замер #2249), кэш, склейка одновременных запросов,
 * запас на 429 и честный отказ. Цена — не только лишние запросы с общего
 * исходящего адреса (суточный лимит уже кончался), но и разные ответы:
 * напоминание о туре и /api/weather брали осадки сводной моделью, погода тура
 * оператора умножала км/ч на 3,6, а отказ в напоминании глушился пустым catch.
 *
 * Четыре пути переведены; погода зон (`zone-weather`) оставлена своим
 * запросом с причиной в шапке модуля — её сторож zone-weather-open-meteo.
 *
 * Поведение судится вызовом: общий прогноз подменён (что и как спрошено,
 * что отдано), а для одного роута — настоящий модуль с подменённым fetch:
 * в запросе должны стоять обе модели общего пути. Регулярка по исходнику —
 * только запрет: прямого адреса прогноза Open-Meteo вне общего модуля нет.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const { fetchForecastDays, swallowed } = vi.hoisted(() => ({ fetchForecastDays: vi.fn(), swallowed: vi.fn() }));
vi.mock('@/lib/planner/intelligence', async (orig) => ({
  ...(await orig<typeof import('@/lib/planner/intelligence')>()),
  fetchForecastDays,
}));
vi.mock('@/lib/observability/swallowed', () => ({
  logSwallowedFailure: (...a: unknown[]) => swallowed(...a),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));

import { NextRequest } from 'next/server';
import { parseForecastNow, type ForecastDay, type ForecastHour, type ForecastNow } from '@/lib/planner/intelligence';
import { fetchWeatherForReminder, reminderWeatherLine, REMINDER_POINT } from '@/lib/weather/tour-reminder-weather';
import { fetchTourWeather } from '@/lib/weather/tour-weather';

beforeEach(() => { fetchForecastDays.mockReset(); swallowed.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function day(date: string, over: Partial<ForecastDay> = {}): ForecastDay {
  return { date, tempMin: 1, tempMax: 6, precipMm: 2.4, windKmh: 30, weatherCode: 61, description: 'Дождь', ...over };
}

function hour(time: string, over: Partial<ForecastHour> = {}): ForecastHour {
  return {
    time, temp: 4, apparent: 1, humidity: 80, precipMm: 0.5, precipProb: 60, windKmh: 20, windGustKmh: 40,
    windDirDeg: 180, weatherCode: 61, description: 'Дождь', cloudCover: 95, visibilityM: 4200, pressureHpa: 1008, uvIndex: 1,
    ...over,
  };
}

const NOW: ForecastNow = {
  time: '2026-10-29T13:00', temp: 4.6, apparent: 0.4, humidity: 82, weatherCode: 61, description: 'Дождь',
  windKmh: 17.2, windGustKmh: 52.3, windDirDeg: 200, pressureHpa: 1006.4, isDay: true,
};

describe('напоминание о туре: прогноз на завтра — общий', () => {
  it('Петропавловск, два дня, строка — по второму дню', async () => {
    fetchForecastDays.mockResolvedValue({ ok: true, days: [day('2026-10-29'), day('2026-10-30', { tempMin: -2, tempMax: 3, precipMm: 7.1, windKmh: 44, weatherCode: 73 })] });
    const line = await fetchWeatherForReminder();
    expect(fetchForecastDays).toHaveBeenCalledWith(REMINDER_POINT.lat, REMINDER_POINT.lng, 2);
    expect(line).toBe('Петропавловск-Камчатский завтра: -2–3°C, снег, осадки 7.1 мм, ветер до 44 км/ч.');
  });

  it('пропуск в прогнозе не становится нулём', () => {
    const line = reminderWeatherLine(day('2026-10-30', { precipMm: null, windKmh: null }));
    expect(line).not.toMatch(/осадки|ветер/);
    expect(line).toContain('1–6°C');
    expect(reminderWeatherLine(day('2026-10-30', { tempMin: null, tempMax: null, precipMm: null, windKmh: null, weatherCode: null }))).toBe('');
  });

  it('отказ прогноза — пустая строка и отказ назван в логе, а не проглочен', async () => {
    fetchForecastDays.mockResolvedValue({ ok: false, reason: 'источник прогноза не ответил вовремя' });
    expect(await fetchWeatherForReminder()).toBe('');
    expect(swallowed).toHaveBeenCalledWith('tour-reminder', 'прогноз на завтра', expect.objectContaining({ message: 'источник прогноза не ответил вовремя' }));

    swallowed.mockReset();
    fetchForecastDays.mockRejectedValue(new Error('boom'));
    expect(await fetchWeatherForReminder()).toBe('');
    expect(swallowed).toHaveBeenCalledWith('tour-reminder', 'прогноз на завтра', expect.objectContaining({ message: 'boom' }));

    swallowed.mockReset();
    fetchForecastDays.mockResolvedValue({ ok: true, days: [day('2026-10-29')] });
    expect(await fetchWeatherForReminder()).toBe('');
    expect(swallowed).toHaveBeenCalledWith('tour-reminder', 'прогноз на завтра', expect.any(Error));
  });
});

describe('погода тура оператора: общий прогноз и честные пропуски', () => {
  it('ветер — км/ч как есть, осадки — сумма трёх часов от текущего', async () => {
    fetchForecastDays.mockResolvedValue({
      ok: true, days: [], now: NOW, fetchedAt: '2026-10-29T00:30:00.000Z',
      hours: [
        hour('2026-10-29T12:00', { precipMm: 9 }),
        hour('2026-10-29T13:00', { precipMm: 0.4 }),
        hour('2026-10-29T14:00', { precipMm: 1.1 }),
        hour('2026-10-29T15:00', { precipMm: 2.0 }),
        hour('2026-10-29T16:00', { precipMm: 9 }),
      ],
    });
    const w = await fetchTourWeather(53.25, 158.83);
    expect(fetchForecastDays).toHaveBeenCalledWith(53.25, 158.83, 1);
    expect(w).toMatchObject({
      wind_speed_kmh: 17, precipitation_mm: 3.5, temperature_c: 5, weather_code: 61,
      visibility_m: 5000, fetched_at: '2026-10-29T00:30:00.000Z', stale_since: null,
    });
  });

  it('нет облачности или осадков в часах — null, а не 50 % и 0 мм', async () => {
    fetchForecastDays.mockResolvedValue({
      ok: true, days: [], now: { ...NOW, weatherCode: 3 },
      hours: [hour('2026-10-29T13:00', { cloudCover: null, precipMm: null }), hour('2026-10-29T14:00'), hour('2026-10-29T15:00')],
    });
    const w = await fetchTourWeather(53, 158);
    expect(w).toMatchObject({ visibility_m: null, precipitation_mm: null, wind_speed_kmh: 17 });
  });

  it('отказ прогноза — отказ, а не нули', async () => {
    fetchForecastDays.mockResolvedValue({ ok: false, reason: 'нет связи с источником прогноза' });
    expect(await fetchTourWeather(53, 158)).toEqual({ failed: 'нет связи с источником прогноза' });
  });
});

describe('/api/weather, провайдер Open-Meteo — через общий прогноз', () => {
  async function callWeather() {
    const { GET } = await import('@/app/api/weather/route');
    const res = await GET(new NextRequest('http://localhost/api/weather?lat=53.02&lng=158.65&provider=openMeteo'));
    return { status: res.status, body: await res.json() as { success: boolean; data?: Record<string, unknown> & { hourlyForecast: Array<{ time: string }>; forecast: Array<{ humidity: number | null; precipitation: number | null }> } } };
  }

  it('сейчас, видимость текущего часа, лента — от текущего часа, влажность дня — среднее часов', async () => {
    fetchForecastDays.mockResolvedValue({
      ok: true, now: NOW, fetchedAt: '2026-10-29T00:30:00.000Z',
      days: [day('2026-10-29', { precipMm: null }), day('2026-10-30')],
      hours: [
        hour('2026-10-29T12:00', { humidity: 60, visibilityM: 100 }),
        hour('2026-10-29T13:00', { humidity: 70, visibilityM: 4200 }),
        hour('2026-10-29T14:00', { humidity: 90 }),
      ],
    });
    const { status, body } = await callWeather();
    expect(status).toBe(200);
    expect(fetchForecastDays).toHaveBeenCalledWith(53.02, 158.65, 7);
    const d = body.data!;
    expect(d).toMatchObject({ temperature: 5, windSpeed: 17, windGust: 52, visibility: 4.2, humidity: 82, pressure: 1006, condition: 'rain' });
    expect(d.lastUpdated).toBe('2026-10-29T00:30:00.000Z');
    expect(d.hourlyForecast.map((h) => h.time)).toEqual(['2026-10-29T13:00', '2026-10-29T14:00']);
    expect(d.forecast[0].humidity).toBe(73);
    expect(d.forecast[0].precipitation).toBeNull();
  });

  it('отказ общего прогноза — 503 и провайдер назван в логе', async () => {
    fetchForecastDays.mockResolvedValue({ ok: false, reason: 'источник прогноза ответил ошибкой (HTTP 429)' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { status, body } = await callWeather();
    expect(status).toBe(503);
    expect(body.success).toBe(false);
    expect(err).toHaveBeenCalledWith('[weather] провайдер не ответил', expect.objectContaining({ provider: 'openMeteo', message: expect.stringContaining('HTTP 429') }));
  });
});

describe('текущий момент при запросе двух моделей', () => {
  it('поля с суффиксом модели читаются: температура и ветер — сводная, код осадков — GFS', () => {
    const now = parseForecastNow({
      time: '2026-10-29T13:00',
      temperature_2m_best_match: 4.6, temperature_2m_gfs_seamless: 9,
      wind_speed_10m_best_match: 17, wind_speed_10m_gfs_seamless: 40,
      weather_code_best_match: 3, weather_code_gfs_seamless: 63,
      is_day_best_match: 1,
    });
    expect(now).toMatchObject({ temp: 4.6, windKmh: 17, weatherCode: 63, isDay: true });
    // Небо сухого часа — сводной модели, как у суток.
    expect(parseForecastNow({ weather_code_best_match: 3, weather_code_gfs_seamless: 45 })?.weatherCode).toBe(3);
    // Без суффикса — как раньше.
    expect(parseForecastNow({ temperature_2m: 2, weather_code: 1 })).toMatchObject({ temp: 2, weatherCode: 1 });
  });
});

describe('/api/public/now идёт через настоящий общий прогноз', () => {
  it('запрос к Open-Meteo — с обеими моделями общего пути, точка /weather', async () => {
    vi.resetModules();
    vi.doUnmock('@/lib/planner/intelligence');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      daily: { time: ['2026-10-29'] },
      hourly: { time: ['2026-10-29T13:00'], temperature_2m_best_match: [3], weather_code_best_match: [3] },
      current: { time: '2026-10-29T13:00', temperature_2m_best_match: 3.2, weather_code_best_match: 3, weather_code_gfs_seamless: 3 },
    }), { status: 200 }));
    const { GET } = await import('@/app/api/public/now/route');
    const body = await (await GET()).json() as { data: { temperature: number | null; weatherDesc: string | null } };
    const urls = fetchSpy.mock.calls.map(([u]) => new URL(String(u)));
    const forecast = urls.filter((u) => u.host === 'api.open-meteo.com');
    expect(forecast).toHaveLength(1);
    expect(forecast[0].searchParams.get('models')?.split(',').sort()).toEqual(['best_match', 'gfs_seamless']);
    expect(forecast[0].searchParams.get('latitude')).toBe('53.02');
    expect(body.data.temperature).toBe(3.2);
    expect(body.data.weatherDesc).toBe('пасмурно');
  });
});

describe('запрет: прямой адрес прогноза Open-Meteo — только в общем модуле', () => {
  /**
   * Исключения с причиной. Самоустаревают: файл без адреса из списка убирается.
   */
  const ALLOWED: Record<string, string> = {
    'lib/planner/intelligence.ts': 'сам общий прогноз',
    'lib/services/safety/zone-weather.ts': 'погода зон: «сейчас» с кэшем 30 мин, не 3 ч; причина в шапке модуля',
  };
  const ROOTS = ['app', 'lib', 'components', 'hooks'];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) files.push(relative(process.cwd(), p));
    }
  };
  for (const r of ROOTS) walk(join(process.cwd(), r));
  const code = (p: string) => readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
  const direct = files.filter((p) => /api\.open-meteo\.com\/v1\/forecast|config\.weather\.openMeteo/.test(code(p)));

  it('вне общего модуля и названных исключений адреса нет', () => {
    expect(direct.filter((p) => !(p in ALLOWED))).toEqual([]);
  });

  it('исключения живые: каждое ещё держит адрес', () => {
    for (const p of Object.keys(ALLOWED)) expect(direct, p).toContain(p);
  });
});
