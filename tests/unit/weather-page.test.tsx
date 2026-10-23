/**
 * Страница погоды `/weather` (решение владельца 08.10).
 *
 * Сторож держит:
 * 1. список мест: адреса, точки внутри края, один источник точки с сводкой и
 *    Кузьмичом;
 * 2. загрузчик: у места три исхода (прогноз / нет места / не получили), у
 *    предупреждений Росгидромета — три (прочитаны / источник молчит / не
 *    прочитаны), и «молчит» не становится «предупреждений нет»;
 * 3. подписи: запятая, минус, м/с, правило осадков частей дня — из day-parts;
 * 4. разметку: предупреждения цветом уровня, текущее место отмечено,
 *    пропуск прогноза назван словами, без хардкода цвета и эмодзи;
 * 5. входы: главная (обе версии), сводка, меню и футер, sitemap.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UTC_WALL_NOW_SQL } from '@/lib/db/timestamp-iso';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';

const { query, resolvePlaceCoords, fetchForecastDays } = vi.hoisted(() => ({
  query: vi.fn(),
  resolvePlaceCoords: vi.fn(),
  fetchForecastDays: vi.fn(),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));
vi.mock('@/lib/kuzmich/weather-tool', async (orig) => ({
  ...(await orig<typeof import('@/lib/kuzmich/weather-tool')>()),
  resolvePlaceCoords,
}));
vi.mock('@/lib/planner/intelligence', async (orig) => ({
  ...(await orig<typeof import('@/lib/planner/intelligence')>()),
  fetchForecastDays,
}));

import {
  DEFAULT_WEATHER_SLUG, WEATHER_PLACES, weatherPlaceBySlug, weatherPlaceHref,
} from '@/lib/weather/places';
import {
  loadMeteoWarnings, loadPlaceWeather, loadWeatherPage, type WeatherPageData,
} from '@/lib/weather/weather-page';
import {
  dayLabel, fmtTemp, partPrecip, precipLine, pressureLine, skyWords, tempRange, uvWords, visibilityLine, warningsSummary,
  windDetail, windLine,
} from '@/lib/weather/weather-format';
import {
  arcPoint, daylightFraction, ringDash, tempCurve, uvMarkerPercent, windArrowRotation,
} from '@/lib/weather/wx-instruments';
import { insideKrai } from '@/lib/geo/krai-envelope';
import { settlementByName } from '@/lib/kuzmich/weather-tool';
import { SVODKA_WEATHER_PLACES } from '@/lib/svodka/svodka';
import { WeatherView, weatherScene, weatherSky } from '@/components/weather/WeatherView';
import { parseForecastNow, type ForecastDay } from '@/lib/planner/intelligence';
import { PLATFORM_LINKS } from '@/lib/navigation/platform-links';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { errSpy.mockRestore(); query.mockReset(); resolvePlaceCoords.mockReset(); fetchForecastDays.mockReset(); });

const day = (date: string, over: Partial<ForecastDay> = {}): ForecastDay => ({
  date, tempMin: 2, tempMax: 7.1, precipMm: 0.8, windKmh: 45.3, weatherCode: 85, description: 'Снегопад',
  parts: [
    { label: 'ночь', precipMm: 0, snowCm: 0, tempMin: 2, tempMax: 3, windKmh: 30 },
    { label: 'утро', precipMm: 0.5, snowCm: 0.3, tempMin: -1, tempMax: 0.4, windKmh: 40 },
    { label: 'день', precipMm: 0.3, snowCm: 0, tempMin: 5, tempMax: 7, windKmh: 45 },
    { label: 'вечер', precipMm: null, snowCm: null, tempMin: null, tempMax: null, windKmh: null },
  ],
  ...over,
});

describe('1. места', () => {
  it('адреса: город — сама /weather, остальные — /weather/<slug>; slug уникален', () => {
    expect(WEATHER_PLACES[0].slug).toBe(DEFAULT_WEATHER_SLUG);
    expect(weatherPlaceHref(WEATHER_PLACES[0])).toBe('/weather');
    expect(weatherPlaceHref({ slug: 'avachinsky' })).toBe('/weather/avachinsky');
    expect(new Set(WEATHER_PLACES.map((p) => p.slug)).size).toBe(WEATHER_PLACES.length);
    for (const p of WEATHER_PLACES) expect(p.slug).toMatch(/^[a-z0-9-]+$/);
    expect(weatherPlaceBySlug('nowhere')).toBeNull();
  });

  it('точка из реестра есть у каждого места и лежит в крае', () => {
    for (const p of WEATHER_PLACES) {
      if ('catalog' in p.source) continue;
      expect(p.source.point, `${p.name}: точки нет в реестре`).not.toBeNull();
      expect(insideKrai(p.source.point!.lat, p.source.point!.lng), p.name).toBe(true);
    }
  });

  it('места сводки — те же точки, что здесь: «Авачинский» здесь и у Кузьмича — одна точка', () => {
    // Точку имени даёт resolvePlaceCoords: сначала реестр посёлков, потом
    // каталог. Страница обязана взять её тем же путём.
    for (const name of SVODKA_WEATHER_PLACES) {
      const s = settlementByName(name);
      const same = WEATHER_PLACES.find((p) => ('catalog' in p.source
        ? s === null && p.source.catalog === name
        : s !== null && p.source.point?.lat === s.lat && p.source.point?.lng === s.lng));
      expect(same, `${name}: на странице погоды не та точка, что в сводке`).toBeTruthy();
    }
  });

  it('Эссо — село по OSM, а не смотровая каталога на ~1430 м (пробы 724–725)', () => {
    const esso = weatherPlaceBySlug('esso')!;
    expect('catalog' in esso.source, 'снова поиск по каталогу — найдёт «Вид на Эссо»').toBe(false);
    const pt = (esso.source as { point: { lat: number; lng: number } | null }).point!;
    // Рамка села по OSM, way 41677471: 55.918–55.936 с. ш., 158.682–158.725 в. д.
    expect(pt.lat).toBeGreaterThanOrEqual(55.918);
    expect(pt.lat).toBeLessThanOrEqual(55.936);
    expect(pt.lng).toBeGreaterThanOrEqual(158.682);
    expect(pt.lng).toBeLessThanOrEqual(158.725);
  });
});

describe('2. загрузчик: три исхода у места', () => {
  const avacha = weatherPlaceBySlug('avachinsky')!;
  const klyuchi = weatherPlaceBySlug('klyuchi')!;
  const okForecast = { ok: true, days: [day('2026-10-09')], elevationM: 2710, fetchedAt: '2026-10-08T03:05:00.000Z' };

  it('прогноз есть — с высотой, моментом получения, без отметки устаревания', async () => {
    resolvePlaceCoords.mockResolvedValue({ name: 'Авачинский', lat: 53.255, lng: 158.83 });
    fetchForecastDays.mockResolvedValue(okForecast);
    const w = await loadPlaceWeather(avacha);
    expect(w).toMatchObject({ kind: 'ok', lat: 53.255, lng: 158.83, elevationM: 2710, fetchedAt: '2026-10-08T03:05:00.000Z', staleSince: null });
    expect(fetchForecastDays).toHaveBeenCalledWith(53.255, 158.83, 7);
  });

  it('места нет в каталоге — «нет места», к Open-Meteo не ходим', async () => {
    resolvePlaceCoords.mockResolvedValue(null);
    expect(await loadPlaceWeather(avacha)).toEqual({ kind: 'missing', place: avacha });
    expect(fetchForecastDays).not.toHaveBeenCalled();
  });

  it('база не ответила — «не получили» с причиной и строкой в логе, а не «нет места»', async () => {
    resolvePlaceCoords.mockRejectedValue(new Error('connection terminated'));
    expect(await loadPlaceWeather(avacha)).toEqual({ kind: 'failed', place: avacha, reason: 'координаты места не прочитаны' });
    expect(errSpy).toHaveBeenCalled();
  });

  it('Open-Meteo не ответил — причина доходит до страницы', async () => {
    fetchForecastDays.mockResolvedValue({ ok: false, reason: 'Open-Meteo HTTP 429' });
    expect(await loadPlaceWeather(klyuchi)).toEqual({ kind: 'failed', place: klyuchi, reason: 'Open-Meteo HTTP 429' });
    expect(fetchForecastDays).toHaveBeenCalledWith(56.32, 160.85, 7);
  });

  it('старый прогноз при молчащем источнике помечен моментом', async () => {
    fetchForecastDays.mockResolvedValue({ ...okForecast, staleSince: '2026-10-08T01:00:00.000Z' });
    expect(await loadPlaceWeather(klyuchi)).toMatchObject({ kind: 'ok', staleSince: '2026-10-08T01:00:00.000Z' });
  });

  it('у посёлка без точки в реестре — «нет места»', async () => {
    const lost = { ...klyuchi, source: { point: null, from: 'посёлки get_weather' } };
    expect(await loadPlaceWeather(lost)).toEqual({ kind: 'missing', place: lost });
  });
});

describe('2. загрузчик: предупреждения Росгидромета', () => {
  const NOW = new Date('2026-10-08T06:00:00Z');
  const ROW = {
    title: 'Росгидромет: ветер — жёлтый уровень (юг края)',
    description: 'Ветер 25 м/с. Уровень по шкале Росгидромета: жёлтый — потенциально опасно.',
    severity: 1, expires_at: new Date('2026-10-09T09:00:00Z'),
  };
  const db = (alerts: unknown[], health: unknown[]) => query.mockImplementation(async (sql: string) =>
    /FROM external_alerts/.test(sql) ? { rows: alerts } : { rows: health });

  it('живой источник — заголовок без «Росгидромет:», уровень, срок', async () => {
    db([ROW, { ...ROW, title: 'Росгидромет: метель — оранжевый уровень (север края)', severity: 2 }],
      [{ last_nonempty_at: new Date('2026-10-08T05:55:00Z') }]);
    const r = await loadMeteoWarnings(NOW);
    expect(r).toEqual({
      kind: 'ok',
      checkedAt: '2026-10-08T05:55:00.000Z',
      items: [
        { title: 'Ветер — жёлтый уровень (юг края)', text: ROW.description, severity: 1, until: '2026-10-09T09:00:00.000Z' },
        { title: 'Метель — оранжевый уровень (север края)', text: ROW.description, severity: 2, until: '2026-10-09T09:00:00.000Z' },
      ],
    });
    const [sql, params] = query.mock.calls.find(([s]) => /FROM external_alerts/.test(String(s)))!;
    expect(String(sql)).toContain(`expires_at > ${UTC_WALL_NOW_SQL}`);
    expect(params).toEqual(['meteoalert/%']);
  });

  it('источник молчит дольше порога — «молчит», даже при пустом списке', async () => {
    db([], [{ last_nonempty_at: new Date('2026-10-07T12:00:00Z') }]);
    expect(await loadMeteoWarnings(NOW)).toEqual({ kind: 'silent', items: [], checkedAt: '2026-10-07T12:00:00.000Z' });
    db([], []);
    expect(await loadMeteoWarnings(NOW)).toEqual({ kind: 'silent', items: [], checkedAt: null });
  });

  it('база не ответила — «не прочитаны», со строкой в логе', async () => {
    query.mockRejectedValue(Object.assign(new Error('timeout'), { code: '57014' }));
    expect(await loadMeteoWarnings(NOW)).toEqual({ kind: 'failed' });
    expect(String(errSpy.mock.calls[0]?.[0])).toMatch(/предупреждения Росгидромета не прочитаны/);
  });

  it('чужой slug — нет страницы; свой — выбранное место среди всех', async () => {
    expect(await loadWeatherPage('nowhere')).toBeNull();
    resolvePlaceCoords.mockResolvedValue({ name: 'x', lat: 53, lng: 158 });
    fetchForecastDays.mockResolvedValue({ ok: true, days: [day('2026-10-08')] });
    db([], [{ last_nonempty_at: new Date() }]);
    const page = await loadWeatherPage('mutnovsky', NOW);
    expect(page?.selected.place.slug).toBe('mutnovsky');
    expect(page?.all.map((w) => w.place.slug)).toEqual(WEATHER_PLACES.map((p) => p.slug));
    expect(page?.today).toBe('2026-10-08');
  });
});

describe('3. подписи', () => {
  it('температура: плюс, настоящий минус, ноль; пропуск — не ноль', () => {
    expect(fmtTemp(5.4)).toBe('+5');
    expect(fmtTemp(-2.6)).toBe('−3');
    expect(fmtTemp(0.2)).toBe('0');
    expect(fmtTemp(null)).toBe('?');
    expect(tempRange(2, 7.1)).toBe('+2…+7°');
    expect(tempRange(3.1, 2.9)).toBe('+3°');
    expect(tempRange(null, 4)).toBe('+4°');
    expect(tempRange(null, null)).toBeNull();
  });

  it('ветер в м/с, осадки с запятой, «нет данных» словами', () => {
    expect(windLine(45.3)).toBe('ветер до 13 м/с');
    expect(windLine(null)).toBe('ветер — нет данных');
    expect(precipLine(0.8)).toBe('осадки 0,8 мм');
    expect(precipLine(0.05)).toBe('без осадков');
    expect(precipLine(null)).toBe('осадки — нет данных');
  });

  it('часть дня говорит правилом day-parts, с запятой', () => {
    expect(partPrecip({ label: 'утро', precipMm: 3.6, snowCm: 2, tempMin: -3, tempMax: -1, windKmh: 20 })).toBe('снег 3,6 мм');
    expect(partPrecip({ label: 'день', precipMm: 1.2, snowCm: 0, tempMin: 4, tempMax: 6, windKmh: 20 })).toBe('дождь 1,2 мм');
    expect(partPrecip({ label: 'ночь', precipMm: null, snowCm: null, tempMin: null, tempMax: null, windKmh: null })).toBe('осадки — нет данных');
  });

  it('небо — только сухого дня или грозы, когда есть части', () => {
    expect(skyWords(day('2026-10-09'))).toBeNull();
    expect(skyWords(day('2026-10-09', { weatherCode: 3, description: 'Пасмурно' }))).toBe('Пасмурно');
    expect(skyWords(day('2026-10-09', { parts: [] }))).toBe('Снегопад');
  });

  it('дни — «Сегодня», «Завтра», дальше день недели и дата', () => {
    expect(dayLabel('2026-10-08', '2026-10-08')).toBe('Сегодня');
    expect(dayLabel('2026-10-09', '2026-10-08')).toBe('Завтра');
    expect(dayLabel('2026-10-10', '2026-10-08')).toMatch(/^сб, 10 октября$/);
  });
});

describe('4. разметка', () => {
  const avacha = weatherPlaceBySlug('avachinsky')!;
  const data = (over: Partial<WeatherPageData> = {}): WeatherPageData => {
    const ok = {
      kind: 'ok' as const, place: avacha, lat: 53.255, lng: 158.83, elevationM: 2710,
      days: [day('2026-10-08'), day('2026-10-09', { precipMm: 0, weatherCode: 3, description: 'Пасмурно' })],
      hours: [], now: null,
      fetchedAt: '2026-10-08T03:05:00.000Z', staleSince: null,
    };
    return {
      selected: ok,
      all: WEATHER_PLACES.map((p) => (p.slug === 'avachinsky' ? ok : { kind: 'failed' as const, place: p, reason: 'Open-Meteo HTTP 429' })),
      warnings: { kind: 'ok', checkedAt: '2026-10-08T05:55:00.000Z', items: [
        { title: 'Ветер — жёлтый уровень (юг края)', text: 'Ветер 25 м/с.', severity: 1, until: '2026-10-09T09:00:00.000Z' },
        { title: 'Метель — красный уровень (север края)', text: 'Метель.', severity: 3, until: null },
      ] },
      today: '2026-10-08',
      generatedAt: '2026-10-08T06:00:00.000Z',
      ...over,
    };
  };

  it('место в заголовке, высота словами, дни и части дня', () => {
    const { container } = render(<WeatherView data={data()} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Погода на Авачинском вулкане');
    expect(screen.getByText(/Высота точки ~2710 м — прогноз для этой высоты/)).toBeTruthy();
    expect(screen.getAllByText('Сегодня').length).toBeGreaterThan(0);
    // Подробности дня — частями, которые не рвутся внутри; читаются одной строкой.
    expect(container.querySelector('section[aria-labelledby="weather-week"]')?.textContent).toMatch(/осадки 0,8 мм · ветер до 13 м\/с/);
    expect(screen.getAllByText('снег 0,5 мм').length).toBeGreaterThan(0);
    // Пропуск части дня — словами, а не нулём.
    expect(screen.getAllByText('нет данных').length).toBeGreaterThan(0);
  });

  it('горная точка в списке мест подписана высотой: −17° вершины — не погода лагеря', () => {
    render(<WeatherView data={data()} />);
    expect(screen.getByText('точка на ~2710 м')).toBeTruthy();
  });

  it('текущее место отмечено, у остальных — честное «прогноз не получили»', () => {
    const { container } = render(<WeatherView data={data()} />);
    const current = container.querySelectorAll('a[aria-current="page"]');
    expect([...current].every((a) => a.getAttribute('href') === '/weather/avachinsky')).toBe(true);
    expect(current.length).toBe(2);
    expect(screen.getAllByText('прогноз не получили').length).toBe(WEATHER_PLACES.length - 1);
  });

  it('предупреждения — цветом уровня и сроком; «не прочитаны» не выдаётся за «нет»', () => {
    const { container, unmount } = render(<WeatherView data={data()} />);
    const items = container.querySelectorAll('section[aria-labelledby="weather-warnings"] ul li');
    expect((items[0] as HTMLElement).style.borderLeftColor).toBe('var(--warning)');
    expect((items[1] as HTMLElement).style.borderLeftColor).toBe('var(--danger)');
    expect(screen.getByText(/Действует до 9 октября/)).toBeTruthy();
    unmount();

    render(<WeatherView data={data({ warnings: { kind: 'failed' } })} />);
    expect(screen.getByText(/Это не «предупреждений нет»/)).toBeTruthy();
    expect(screen.queryByText('Действующих предупреждений нет.')).toBeNull();
  });

  it('источник молчит — пустой список не читается «всё спокойно»', () => {
    render(<WeatherView data={data({ warnings: { kind: 'silent', items: [], checkedAt: '2026-10-07T12:00:00.000Z' } })} />);
    expect(screen.getByText(/Источник предупреждений не отвечает с 8 октября/)).toBeTruthy();
    expect(screen.queryByText('Действующих предупреждений нет.')).toBeNull();
  });

  it('устаревший прогноз назван устаревшим, время получения — не время сборки', () => {
    const d = data();
    const stale = { ...(d.selected as Extract<typeof d.selected, { kind: 'ok' }>), staleSince: '2026-10-08T01:00:00.000Z' };
    render(<WeatherView data={{ ...d, selected: stale }} />);
    expect(screen.getByText(/последний полученный прогноз — от 8 октября в 13:00/)).toBeTruthy();
    expect(screen.queryByText(/Прогноз получен/)).toBeNull();
  });

  it('без хардкода цвета, эмодзи, белого на сплошном и font-black', () => {
    for (const f of ['components/weather/WeatherView.tsx', 'app/weather/(list)/page.tsx', 'app/weather/[place]/page.tsx']) {
      const src = read(f);
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src, f).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(src, f).not.toMatch(/\b(text-white|bg-white|font-black)\b|@keyframes/);
    }
  });

  it('страницы рендерятся на запрос; чужое место — 404, город — на /weather', () => {
    expect(read('app/weather/(list)/page.tsx')).toMatch(/export const dynamic = 'force-dynamic'/);
    const place = read('app/weather/[place]/page.tsx');
    expect(place).toMatch(/export const dynamic = 'force-dynamic'/);
    expect(place).toMatch(/if \(slug === DEFAULT_WEATHER_SLUG\) permanentRedirect\('\/weather'\)/);
    expect(place).toMatch(/if \(!data\) notFound\(\)/);
  });

  it('скелет — только у страницы края: над местами его нет, иначе 404 и 308 ушли бы как 200', () => {
    const { existsSync } = require('node:fs') as typeof import('node:fs');
    expect(existsSync(join(process.cwd(), 'app/weather/(list)/loading.tsx'))).toBe(true);
    expect(existsSync(join(process.cwd(), 'app/weather/loading.tsx'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'app/weather/[place]/loading.tsx'))).toBe(false);
  });
});

describe('4b. виджет: ветер, давление', () => {
  it('ветер с направлением и порывами, давление в мм рт. ст., видимость и УФ', () => {
    expect(windDetail(36, 72, 315)).toContain('10 м/с');
    expect(windDetail(36, 72, 315)).toContain('северо-западный');
    expect(windDetail(null, null, null)).toBe('нет данных');
    expect(pressureLine(1000)).toBe('750 мм рт. ст.');
    expect(visibilityLine(25000)).toBe('25 км');
    expect(uvWords(2.4)).toContain('низкий');
  });
  it('давление «сейчас» — приведённое к уровню моря, а не на высоте точки', () => {
    // Авачинский: surface_pressure ~715 гПа (536 мм) при pressure_msl ~1015 гПа (761 мм).
    expect(parseForecastNow({ pressure_msl: 1015, surface_pressure: 715 })?.pressureHpa).toBe(1015);
    expect(parseForecastNow({ surface_pressure: 715 })?.pressureHpa).toBeNull();
    expect(parseForecastNow({ pressure_msl: 1015 })).toBeTruthy();
  });
  it('плитка давления: нет приведённого — нет плитки, а не подстановка surface', () => {
    const mk = (now: unknown) => {
      const base = {
        kind: 'ok' as const, place: weatherPlaceBySlug('avachinsky')!, lat: 53.255, lng: 158.83, elevationM: 2710,
        days: [day('2026-10-08')], hours: [], now, fetchedAt: null, staleSince: null,
      };
      return {
        selected: base, all: [base],
        warnings: { kind: 'ok' as const, checkedAt: '2026-10-08T05:55:00.000Z', items: [] },
        today: '2026-10-08', generatedAt: '2026-10-08T06:00:00.000Z',
      } as WeatherPageData;
    };
    const noPressure = { time: '2026-10-08T06:00', temp: 1, apparent: null, humidity: null, weatherCode: 3, description: null, windKmh: null, windGustKmh: null, windDirDeg: null, pressureHpa: null, isDay: true };
    const { unmount } = render(<WeatherView data={mk(noPressure)} />);
    expect(screen.queryByText('Давление')).toBeNull();
    unmount();
    render(<WeatherView data={mk({ ...noPressure, pressureHpa: 1015 })} />);
    expect(screen.getByText('Давление')).toBeTruthy();
    // Показание — число крупно и единица мельче рядом, одной строкой для читателя.
    expect(screen.getByText((_, el) => el?.textContent === '761 мм рт. ст.')).toBeTruthy();
    expect(screen.getByText('к уровню моря')).toBeTruthy();
  });
  it('пустые предупреждения — одна строка, а не карточка с заголовком', () => {
    render(<WeatherView data={(function () {
      const base = {
        kind: 'ok' as const, place: weatherPlaceBySlug('avachinsky')!, lat: 53.255, lng: 158.83, elevationM: 2710,
        days: [day('2026-10-08')], hours: [], now: null, fetchedAt: null, staleSince: null,
      };
      return {
        selected: base, all: [base],
        warnings: { kind: 'ok' as const, checkedAt: '2026-10-08T05:55:00.000Z', items: [] },
        today: '2026-10-08', generatedAt: '2026-10-08T06:00:00.000Z',
      };
    })()} />);
    expect(screen.getByText(/Действующих предупреждений нет/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /Предупреждения Росгидромета/ })).toBeNull();
  });
});

describe('4c. сцена героя: период и небо из прогноза', () => {
  const base = (over: Record<string, unknown> = {}) => ({
    kind: 'ok' as const, place: weatherPlaceBySlug('avachinsky')!, lat: 53.255, lng: 158.83, elevationM: 2710,
    days: [day('2026-10-08', { sunrise: '2026-10-08T07:00', sunset: '2026-10-08T18:30' })],
    hours: [], now: null, fetchedAt: null, staleSince: null, ...over,
  });
  it('небо — по WMO-коду, пропуск кода не становится ясным', () => {
    expect(weatherSky(0)).toBe('clear');
    expect(weatherSky(3)).toBe('cloud');
    expect(weatherSky(45)).toBe('fog');
    expect(weatherSky(61)).toBe('rain');
    expect(weatherSky(71)).toBe('snow');
    expect(weatherSky(85)).toBe('snow');
    expect(weatherSky(95)).toBe('storm');
    expect(weatherSky(null)).toBe('cloud');
  });
  it('ночь и день — сначала is_day источника', () => {
    expect(weatherScene(base({ now: { time: '2026-10-08T13:00', temp: 1, apparent: null, humidity: null, weatherCode: 3, description: null, windKmh: null, windGustKmh: null, windDirDeg: null, pressureHpa: null, isDay: false } }) as never, '2026-10-08').name).toBe('night-cloud');
    expect(weatherScene(base({ now: { time: '2026-10-08T01:00', temp: 1, apparent: null, humidity: null, weatherCode: 0, description: null, windKmh: null, windGustKmh: null, windDirDeg: null, pressureHpa: null, isDay: true } }) as never, '2026-10-08').name).toBe('day-clear');
  });
  it('без is_day период — между восходом и закатом дня', () => {
    const now = { time: '2026-10-08T23:10', temp: 1, apparent: null, humidity: null, weatherCode: 71, description: null, windKmh: null, windGustKmh: null, windDirDeg: null, pressureHpa: null, isDay: null };
    expect(weatherScene(base({ now }) as never, '2026-10-08').name).toBe('night-snow');
  });
  it('рендер: герой, часы и неделя — в одной сцене со стеклянными плашками', () => {
    const selected = base({ now: { time: '2026-10-08T13:00', temp: 1, apparent: null, humidity: null, weatherCode: 3, description: 'Пасмурно', windKmh: null, windGustKmh: null, windDirDeg: null, pressureHpa: null, isDay: false } });
    const d: WeatherPageData = {
      selected: selected as WeatherPageData['selected'],
      all: [selected as WeatherPageData['selected']],
      warnings: { kind: 'ok', checkedAt: '2026-10-08T05:55:00.000Z', items: [] },
      today: '2026-10-08', generatedAt: '2026-10-08T06:00:00.000Z',
    };
    const { container } = render(<WeatherView data={d} />);
    const scene = container.querySelector('.wx-scene');
    expect(scene).toBeTruthy();
    expect(scene?.getAttribute('data-wx-scene')).toBe('night-cloud');
    expect(scene?.querySelectorAll('.wx-glass').length).toBeGreaterThanOrEqual(2);
    expect(scene?.querySelector('svg.wx-silhouette-svg')).toBeTruthy();
  });
});

/**
 * Стиль Samsung Weather (слово владельца 22.10: «сделай в стиле самсунг
 * погода»): крупная температура слева, лента часов с линией температуры,
 * неделя «день · вероятность осадков · знак · макс/мин», плитки-приборы.
 * Геометрия приборов — чистые функции; разметка — рендером, с данными.
 */
describe('4d. стиль Samsung Weather: приборы', () => {
  it('линия температуры: теплее — выше, пропуск рвёт линию, ровный день — посередине', () => {
    const c = tempCurve([0, 10, 5], { col: 64, height: 72, padTop: 26, padBottom: 10 });
    expect(c.points.map((p) => p && [p.x, p.y])).toEqual([[32, 62], [96, 26], [160, 44]]);
    expect(c.path).toBe('M32 62 C64 62 64 26 96 26 C128 26 128 44 160 44');
    const gap = tempCurve([1, null, 3], { col: 64, height: 72, padTop: 26, padBottom: 10 });
    expect(gap.points[1]).toBeNull();
    expect(gap.path.match(/M/g)?.length).toBe(2);
    expect(tempCurve([4, 4], { col: 64, height: 72, padTop: 26, padBottom: 10 }).points.map((p) => p?.y)).toEqual([44, 44]);
    expect(tempCurve([null, null], { col: 64, height: 72, padTop: 26, padBottom: 10 })).toEqual({ points: [null, null], path: '', min: null, max: null });
  });
  it('солнце на дуге: доля светового дня; ночью и без восхода — нет солнца', () => {
    expect(daylightFraction('07:00', '19:00', '13:00')).toBe(0.5);
    expect(daylightFraction('07:00', '19:00', '06:59')).toBeNull();
    expect(daylightFraction('07:00', '19:00', '19:01')).toBeNull();
    expect(daylightFraction(null, '19:00', '13:00')).toBeNull();
    expect(daylightFraction('19:00', '07:00', '13:00')).toBeNull();
    expect(arcPoint(0.5, { x: 12, y: 56 }, { x: 120, y: -16 }, { x: 228, y: 56 })).toEqual({ x: 120, y: 20 });
  });
  it('стрелка ветра летит по ветру; шкала УФ и кольцо — в своих пределах', () => {
    expect(windArrowRotation(315)).toBe(135);
    expect(windArrowRotation(0)).toBe(180);
    expect(windArrowRotation(-90)).toBe(90);
    expect(windArrowRotation(null)).toBeNull();
    expect(uvMarkerPercent(5.5)).toBe(50);
    expect(uvMarkerPercent(15)).toBe(100);
    expect(uvMarkerPercent(-1)).toBe(0);
    expect(uvMarkerPercent(null)).toBeNull();
    expect(ringDash(50, 24)).toEqual({ filled: 75.4, circumference: 150.8 });
    expect(ringDash(140, 24).filled).toBe(150.8);
  });

  const hour = (time: string, temp: number | null, over: Record<string, unknown> = {}) => ({
    time, temp, apparent: null, humidity: null, precipMm: 0, precipProb: 10, windKmh: null, windGustKmh: null,
    windDirDeg: null, weatherCode: 1, description: null, cloudCover: null, visibilityM: null, pressureHpa: null, uvIndex: null,
    ...over,
  });
  const page = (now: Record<string, unknown>, over: Record<string, unknown> = {}): WeatherPageData => {
    const selected = {
      kind: 'ok' as const, place: weatherPlaceBySlug('avachinsky')!, lat: 53.255, lng: 158.83, elevationM: 2710,
      days: [
        day('2026-10-08', { sunrise: '2026-10-08T07:00', sunset: '2026-10-08T18:30', precipProbMax: 40, uvIndexMax: 3.4 }),
        day('2026-10-09', { precipProbMax: null }),
      ],
      hours: [hour('2026-10-08T13:00', 5), hour('2026-10-08T14:00', 7), hour('2026-10-08T15:00', null), hour('2026-10-08T16:00', 3)],
      now: {
        time: '2026-10-08T13:00', temp: 5, apparent: 2, humidity: 78, weatherCode: 1, description: 'Малооблачно',
        windKmh: 36, windGustKmh: 72, windDirDeg: 315, pressureHpa: 1015, isDay: true, ...now,
      },
      fetchedAt: '2026-10-08T03:05:00.000Z', staleSince: null, ...over,
    };
    return {
      selected: selected as WeatherPageData['selected'],
      all: [selected as WeatherPageData['selected']],
      warnings: { kind: 'ok', checkedAt: '2026-10-08T05:55:00.000Z', items: [] },
      today: '2026-10-08', generatedAt: '2026-10-08T06:00:00.000Z',
    };
  };

  it('сцена начинается заголовком страницы; крупная температура и «ощущается»', () => {
    const { container } = render(<WeatherView data={page({})} />);
    const scene = container.querySelector('.wx-scene')!;
    expect(scene.querySelector('h1')?.textContent).toBe('Погода на Авачинском вулкане');
    expect(scene.querySelector('[aria-label="Сейчас +5 градусов"]')?.textContent).toBe('+5°');
    expect(screen.getByText('Ощущается как +2°')).toBeTruthy();
    expect(screen.getByText('при температуре воздуха +5°')).toBeTruthy();
  });

  it('предупреждения в сцене — стеклом с кромкой цвета предупреждения', () => {
    const d = page({});
    const { container } = render(<WeatherView data={{
      ...d,
      warnings: { kind: 'ok', checkedAt: '2026-10-08T05:55:00.000Z', items: [{ title: 'Ветер — жёлтый уровень', text: null, severity: 1, until: null }] },
    }} />);
    const section = container.querySelector('.wx-scene section[aria-labelledby="weather-warnings"]') as HTMLElement;
    expect(section.classList.contains('wx-glass')).toBe(true);
    expect(section.style.borderLeftColor).toBe('var(--warning)');
    expect(section.style.borderLeftWidth).toBe('4px');
  });

  // Владелец 22.10 (снимок телефона): «этот блок нужно свернуть а то пока до
  // погоды долистать не у всех терпение хватит» — три оранжевых предупреждения
  // занимали весь экран. Свёрнут текст, не сигнал.
  const ORANGE = [
    { title: 'Ветер — оранжевый уровень (север края)', text: '15-20 м/с, местами 25-30 м/с.', severity: 2 as const, until: '2026-10-23T09:00:00.000Z' },
    { title: 'Дождь — оранжевый уровень (север края)', text: 'Сильный дождь со снегом.', severity: 2 as const, until: null },
    { title: 'Ветер — оранжевый уровень (юг края)', text: '17-22 м/с.', severity: 2 as const, until: null },
  ];
  const withWarnings = (items: typeof ORANGE | Array<{ title: string; text: string; severity: 1 | 2 | 3; until: string | null }>, kind: 'ok' | 'silent' = 'ok') =>
    render(<WeatherView data={{ ...page({}), warnings: { kind, checkedAt: '2026-10-08T05:55:00.000Z', items } }} />);

  it('сводка предупреждений: число, высший уровень, явления без повторов', () => {
    expect(warningsSummary(ORANGE)).toEqual({
      line: '3 предупреждения · высший уровень — оранжевый', phenomena: 'Ветер, дождь', highest: 2,
    });
    expect(warningsSummary([{ title: 'Метель — красный уровень', severity: 3 }, { title: 'Ветер — жёлтый уровень', severity: 1 }])?.line)
      .toBe('2 предупреждения · высший уровень — красный');
    expect(warningsSummary([{ title: 'Туман — жёлтый уровень', severity: 1 }])?.line).toBe('1 предупреждение · высший уровень — жёлтый');
    expect(warningsSummary([])).toBeNull();
  });

  it('предупреждения свёрнуты: на виду сводка, текст — по касанию', () => {
    const { container } = withWarnings(ORANGE);
    const details = container.querySelector('section[aria-labelledby="weather-warnings"] details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    const summary = details.querySelector('summary')!;
    expect(summary.textContent).toContain('Предупреждения Росгидромета');
    expect(summary.textContent).toContain('3 предупреждения · высший уровень — оранжевый');
    expect(summary.textContent).toContain('Ветер, дождь');
    // Подробности — внутри свёрнутого, а не в сводке.
    expect(summary.textContent).not.toContain('15-20 м/с');
    expect(details.querySelectorAll('ul li').length).toBe(3);
  });

  it('оранжевый уровень — оранжевой кромкой, а не синим --accent светлой темы', () => {
    const { container } = withWarnings(ORANGE);
    const li = container.querySelector('section[aria-labelledby="weather-warnings"] ul li') as HTMLElement;
    expect(li.style.borderLeftColor).toBe('var(--wx-level-orange)');
    expect(container.querySelector('section[aria-labelledby="weather-warnings"]')!.classList.contains('wx-alerts')).toBe(true);
    const css = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf-8');
    expect(css).toMatch(/\.wx-alerts\s*\{\s*--wx-level-orange:\s*#[0-9A-Fa-f]{6};/);
  });

  it('красный уровень — «опасно для жизни» — раскрыт сразу', () => {
    const { container } = withWarnings([...ORANGE, { title: 'Метель — красный уровень (север края)', text: 'Метель.', severity: 3, until: null }]);
    const details = container.querySelector('section[aria-labelledby="weather-warnings"] details') as HTMLDetailsElement;
    expect(details.open).toBe(true);
  });

  it('источник молчит — это видно и в свёрнутом виде', () => {
    const { container } = withWarnings(ORANGE, 'silent');
    const summary = container.querySelector('section[aria-labelledby="weather-warnings"] summary')!;
    expect(summary.textContent).toMatch(/Источник предупреждений не отвечает/);
  });

  it('лента часов: линия температуры рвётся на пропуске, подписи у точек', () => {
    const { container } = render(<WeatherView data={page({})} />);
    const hourly = container.querySelector('section[aria-labelledby="weather-hourly"]')!;
    const curve = hourly.querySelector('svg[data-wx-curve]')!;
    const path = curve.querySelector('path')!.getAttribute('d')!;
    expect(path.match(/M/g)?.length).toBe(2);
    expect(curve.querySelectorAll('circle').length).toBe(3);
    expect(hourly.textContent).toContain('Сейчас');
    expect(hourly.textContent).toContain('+7°');
    // Час без температуры — прочерк, а не ноль на линии.
    expect(hourly.textContent).toContain('—');
  });

  it('неделя: вероятность осадков у дня, пропуск — прочерк; подробности строкой', () => {
    const { container } = render(<WeatherView data={page({})} />);
    const rows = container.querySelectorAll('section[aria-labelledby="weather-week"] ol > li');
    expect(rows[0].textContent).toContain('40%');
    expect(rows[0].textContent).toContain('Сегодня');
    expect(rows[1].textContent).toContain('—');
    expect(rows[1].textContent).toContain('Завтра');
    expect(rows[0].textContent).toContain('осадки 0,8 мм · ветер до 13 м/с');
  });

  it('плитки-приборы: компас по ветру, кольцо влажности, шкала УФ, солнце над горизонтом днём', () => {
    const { container } = render(<WeatherView data={page({})} />);
    expect(container.querySelector('g[transform="rotate(135 40 40)"]')).toBeTruthy();
    expect(screen.getByText('северо-западный')).toBeTruthy();
    expect(screen.getByText('порывы 20 м/с')).toBeTruthy();
    expect(screen.getByText('78%')).toBeTruthy();
    expect(screen.getByText(/3,4 · умеренный/)).toBeTruthy();
    expect(container.querySelector('svg[data-sun="up"]')).toBeTruthy();
    expect(screen.getByText('Восход 07:00')).toBeTruthy();
    expect(screen.getByText('Закат 18:30')).toBeTruthy();
    expect(screen.queryByText('Солнце за горизонтом')).toBeNull();
  });

  it('ночью солнца на дуге нет, это сказано словами; без направления ветра стрелки нет', () => {
    const { container } = render(<WeatherView data={page({ time: '2026-10-08T22:00', isDay: false, windDirDeg: null })} />);
    expect(container.querySelector('svg[data-sun="down"]')).toBeTruthy();
    expect(screen.getByText('Солнце за горизонтом')).toBeTruthy();
    expect(container.querySelector('g[transform^="rotate("]')).toBeNull();
  });
});

describe('5. входы на страницу', () => {
  it('меню и футер — из реестра ссылок', () => {
    expect(PLATFORM_LINKS.some((l) => l.href === '/weather')).toBe(true);
  });

  it('sitemap: страница края и страницы мест из того же списка', () => {
    const src = read('lib/seo/sitemap-entries.ts');
    expect(src).toContain('`${BASE}/weather`');
    expect(src).toMatch(/WEATHER_PLACES\.filter\(\(p\) => p\.slug !== DEFAULT_WEATHER_SLUG\)\.map/);
  });

  it('сводка, мобильная и десктопная главная ведут на погоду', () => {
    expect(read('app/svodka/page.tsx')).toMatch(/<Link href="\/weather"/);
    // С 23.10 вход с мобильной главной — виджет погоды между рядами плиток
    // (рендер — tests/unit/home-weather-strip.test.tsx).
    expect(read('components/homepage/HomeWeatherStrip.tsx')).toMatch(/href="\/weather"/);
    const desk = read('components/homepage/desk/DeskHero.tsx');
    expect(desk).toMatch(/href: '\/weather\/avachinsky'/);
    // Плитка не показывает «худшее за сутки» при частях дня (#2249).
    expect(desk).toMatch(/keepDailyDescription\(day\.weatherCode/);
  });
});
