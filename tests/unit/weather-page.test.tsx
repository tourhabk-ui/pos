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
  dayLabel, fmtTemp, partPrecip, precipLine, skyWords, tempRange, windLine,
} from '@/lib/weather/weather-format';
import { insideKrai } from '@/lib/geo/krai-envelope';
import { settlementByName } from '@/lib/kuzmich/weather-tool';
import { SVODKA_WEATHER_PLACES } from '@/lib/svodka/svodka';
import { WeatherView } from '@/components/weather/WeatherView';
import type { ForecastDay } from '@/lib/planner/intelligence';
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
    expect(String(sql)).toMatch(/expires_at > NOW\(\)/);
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
    render(<WeatherView data={data()} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Погода на Авачинском вулкане');
    expect(screen.getByText(/Высота точки ~2710 м — прогноз для этой высоты/)).toBeTruthy();
    expect(screen.getByText('Сегодня')).toBeTruthy();
    expect(screen.getAllByText(/осадки 0,8 мм · ветер до 13 м\/с/).length).toBeGreaterThan(0);
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
    const items = container.querySelectorAll('#weather-warnings ~ ul li');
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
    expect(read('app/_home/_HomeV8Client.tsx')).toMatch(/href="\/weather"/);
    const desk = read('components/homepage/desk/DeskHero.tsx');
    expect(desk).toMatch(/href: '\/weather\/avachinsky'/);
    // Плитка не показывает «худшее за сутки» при частях дня (#2249).
    expect(desk).toMatch(/keepDailyDescription\(day\.weatherCode/);
  });
});
