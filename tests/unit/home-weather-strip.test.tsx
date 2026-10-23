// @vitest-environment jsdom
/**
 * Виджет погоды на главной (слово владельца 23.10: «между кнопками своя
 * поездка и радар … длинный стильный виджет с погодой, при нажатии переход на
 * страницу погоды»).
 *
 *  - правило данных — вызовом: температура, небо, ветер, ближайшие дни,
 *    предупреждение только когда оно есть, сцена — та же, что у /weather;
 *  - бюджет главной: прогноз не успел — «pending», главная не ждёт 12 с;
 *  - плитка — рендером: ведёт на /weather, называет погоду словами для
 *    диктора, без прогноза — «не загрузился» и ни одной выдуманной цифры,
 *    «pending» дотягивает данные из /api/weather/home;
 *  - цвет — каскадом настоящего CSS главной и сцены из globals.css: текст
 *    плитки берёт палитру сцены, а не темы страницы.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
import { homeWeatherFrom, loadHomeWeatherWithin } from '@/lib/weather/home-widget';
import { HOME_WEATHER_ENDPOINT, type HomeWeather } from '@/lib/weather/home-widget-types';
import { weatherScene } from '@/lib/weather/scene';
import { HomeWeatherStrip } from '@/components/homepage/HomeWeatherStrip';
import type { PlaceWeather, WarningsRead } from '@/lib/weather/weather-page';
import HomeV8Client from '@/app/_home/_HomeV8Client';
import type { HomeV8Data } from '@/app/_home/data';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const NOW = new Date('2026-10-23T03:00:00Z'); // 15:00 по Камчатке, 23 октября
const day = (date: string, max: number | null, min: number | null, code: number | null, description: string | null = null) => ({
  date, tempMax: max, tempMin: min, precipMm: 0, windKmh: 18, weatherCode: code, description,
  sunrise: `${date}T08:40`, sunset: `${date}T19:10`,
});

const OK: PlaceWeather = {
  kind: 'ok',
  place: { slug: 'petropavlovsk', name: 'Петропавловск-Камчатский', where: 'в Петропавловске-Камчатском', group: 'city', source: { point: { lat: 53.04, lng: 158.65 }, from: 'тест' } },
  lat: 53.04, lng: 158.65, elevationM: 20,
  days: [
    day('2026-10-23', 6, 1, 3, 'Пасмурно'),
    day('2026-10-24', 7, 2, 61),
    day('2026-10-25', 4, -1, 71),
    day('2026-10-26', 3, -2, 0),
    day('2026-10-27', 5, 0, 2),
  ],
  hours: [],
  now: { time: '2026-10-23T15:00', temp: 4.4, apparent: 1, humidity: 80, weatherCode: 3, description: 'Пасмурно', windKmh: 18, windGustKmh: 30, windDirDeg: 90, pressureHpa: 1012, isDay: true },
  fetchedAt: '2026-10-23T02:30:00Z',
  staleSince: null,
};

const NO_WARNINGS: WarningsRead = { kind: 'ok', items: [], checkedAt: '2026-10-23T02:00:00Z' };

describe('правило данных виджета', () => {
  it('сейчас, небо, ветер и три ближайших дня — из прогноза Петропавловска', () => {
    const w = homeWeatherFrom(OK, NO_WARNINGS, NOW);
    expect(w).toMatchObject({
      kind: 'ok', place: 'Петропавловск-Камчатский', temp: '+4', code: 3, isDay: true,
      sky: 'пасмурно', wind: 'ветер до 5 м/с', warning: null, staleFrom: null,
    });
    if (w.kind !== 'ok') throw new Error('ожидался прогноз');
    expect(w.days.map((d) => [d.weekday, d.max])).toEqual([['Сб', '+7'], ['Вс', '+4'], ['Пн', '+3']]);
  });

  it('сцена — та же, что у героя страницы погоды', () => {
    const w = homeWeatherFrom(OK, NO_WARNINGS, NOW);
    const s = weatherScene(OK as Extract<PlaceWeather, { kind: 'ok' }>, '2026-10-23');
    expect(w).toMatchObject({ scene: s.name, period: s.period, skyKind: s.sky });
  });

  it('предупреждение — самое серьёзное и их число; молчащий источник без пунктов — не «нет предупреждений», а ничего', () => {
    const warns: WarningsRead = {
      kind: 'ok', checkedAt: '2026-10-23T02:00:00Z', items: [
        { title: 'Дождь — жёлтый уровень', text: '', severity: 1, until: null },
        { title: 'Ветер — оранжевый уровень (юг края)', text: '', severity: 2, until: null },
      ],
    };
    expect(homeWeatherFrom(OK, warns, NOW)).toMatchObject({ warning: { count: 2, severity: 2, title: 'Ветер — оранжевый уровень (юг края)' } });
    expect(homeWeatherFrom(OK, { kind: 'silent', items: [], checkedAt: null }, NOW)).toMatchObject({ warning: null });
    expect(homeWeatherFrom(OK, { kind: 'failed' }, NOW)).toMatchObject({ warning: null });
  });

  it('чего в прогнозе нет — того нет и в виджете: ни нуля, ни «?»', () => {
    const empty = { ...OK, now: null, days: [day('2026-10-23', null, null, null), day('2026-10-24', null, null, null)] } as PlaceWeather;
    expect(homeWeatherFrom(empty, NO_WARNINGS, NOW)).toMatchObject({ temp: null, sky: null, wind: null, days: [{ max: null }] });
  });

  it('прогноза нет — исход failed; старый прогноз помечен временем', () => {
    expect(homeWeatherFrom({ kind: 'failed', place: OK.place, reason: 'Open-Meteo 503' } as PlaceWeather, NO_WARNINGS, NOW)).toEqual({ kind: 'failed' });
    const stale = homeWeatherFrom({ ...OK, staleSince: '2026-10-22T20:05:00Z' } as PlaceWeather, NO_WARNINGS, NOW);
    expect(stale.kind === 'ok' && stale.staleFrom).toMatch(/23 октября в 08:05/);
  });
});

describe('бюджет главной', () => {
  it('прогноз не успел за бюджет — pending, главная не ждёт', async () => {
    const slow = () => new Promise<HomeWeather>((r) => setTimeout(() => r({ kind: 'failed' }), 200));
    expect(await loadHomeWeatherWithin(20, NOW, slow)).toEqual({ kind: 'pending' });
  });

  it('успел — отдаётся как есть', async () => {
    const fast = async (): Promise<HomeWeather> => homeWeatherFrom(OK, NO_WARNINGS, NOW);
    expect(await loadHomeWeatherWithin(500, NOW, fast)).toMatchObject({ kind: 'ok', temp: '+4' });
  });
});

describe('плитка на главной', () => {
  it('прогноз есть: ведёт на /weather, крупная температура, небо, дни; диктору — словами', () => {
    render(<HomeWeatherStrip initial={homeWeatherFrom(OK, NO_WARNINGS, NOW)} />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/weather');
    expect(link.getAttribute('aria-label')).toBe('Погода: Петропавловск. сейчас +4°. пасмурно. ветер до 5 м/с. Открыть прогноз на 7 дней');
    expect(link.textContent).toContain('+4°');
    expect(link.textContent).toContain('Погода · Петропавловск');
    expect(link.textContent).toContain('Пасмурно');
    expect(link.textContent).toContain('Сб');
    expect(link.getAttribute('data-wx-scene')).toBe('day-cloud');
  });

  it('предупреждение — строкой внутри плитки, с числом остальных', () => {
    const warns: WarningsRead = {
      kind: 'ok', checkedAt: '2026-10-23T02:00:00Z', items: [
        { title: 'Ветер — жёлтый уровень', text: '', severity: 1, until: null },
        { title: 'Дождь — жёлтый уровень', text: '', severity: 1, until: null },
      ],
    };
    render(<HomeWeatherStrip initial={homeWeatherFrom(OK, warns, NOW)} />);
    expect(screen.getByText('Ветер — жёлтый уровень')).toBeTruthy();
    expect(screen.getByText('и ещё 1')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('aria-label')).toContain('предупреждение: Ветер — жёлтый уровень и ещё 1');
  });

  it('прогноз не загрузился: так и сказано, цифр нет, ссылка на страницу остаётся', () => {
    render(<HomeWeatherStrip initial={{ kind: 'failed' }} />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/weather');
    expect(link.textContent).toContain('прогноз сейчас не загрузился');
    // Ни температуры, ни градусов: подпись «на 7 дней» — про страницу, не про погоду.
    expect(link.textContent).not.toMatch(/°|[+−-]\d/);
  });

  it('pending: та же плитка дотягивает прогноз из /api/weather/home', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(homeWeatherFrom(OK, NO_WARNINGS, NOW)), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<HomeWeatherStrip initial={{ kind: 'pending' }} />);
    expect(screen.getByRole('link').textContent).toContain('загружаем прогноз');
    await waitFor(() => expect(screen.getByRole('link').textContent).toContain('+4°'));
    expect(fetchMock).toHaveBeenCalledWith(HOME_WEATHER_ENDPOINT);
  });

  it('pending и отказ запроса — «не загрузился», а не вечная загрузка', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ kind: 'failed' }), { status: 502 })));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<HomeWeatherStrip initial={{ kind: 'pending' }} />);
    await waitFor(() => expect(screen.getByRole('link').textContent).toContain('прогноз сейчас не загрузился'));
  });
});

// Снимок владельца 23.10 («видишь баг?»): ночью в светлой теме «+4°»,
// «Малооблачно», «+7°» и строка предупреждения — тёмным по тёмно-синему.
// Правило главной «.v7 a{color:inherit}» сильнее «.wx-scene{color:…}», и
// ссылка брала цвет текста темы страницы. В тёмной теме днём было бы обратное:
// светлое по светлому небу. jsdom считает каскад и наследование, но не
// раскрывает var(): поэтому сравнивается, какой токен победил.
describe('цвет плитки — от сцены, не от темы страницы', () => {
  const globals = readFileSync('app/globals.css', 'utf-8');
  const SCENE_CSS = globals.slice(globals.indexOf('.wx-scene {'), globals.indexOf('/* SectionSwipeBar'));
  const DATA: HomeV8Data = {
    safety: { activeCount: 0, maxSeverity: 0, alerts: [], volcanoes: [], updatedAt: null },
    seismic: { events: [], source: 'none', updatedAt: null, checkedAt: null },
    radar: { hazards: [], center: { lat: 53.04, lng: 158.65, label: 'Петропавловск-Камчатский' } },
    zones: { open: 0, total: 0, updatedAt: null },
    plates: [], transfer: null, stay: null, explore: [], feed: [], stats: [], elements: [],
  };
  const WARN: WarningsRead = {
    kind: 'ok', checkedAt: '2026-10-23T02:00:00Z',
    items: [{ title: 'Ветер — жёлтый уровень (север края)', text: '', severity: 1, until: null }],
  };
  const NIGHT = { ...OK, now: { ...(OK as Extract<PlaceWeather, { kind: 'ok' }>).now!, isDay: false, weatherCode: 1 } } as PlaceWeather;

  function home(weather: HomeWeather) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    // Порядок как на сайте: globals.css в <head>, CSS главной — в её <style> ниже.
    const scene = document.createElement('style');
    scene.textContent = SCENE_CSS;
    document.head.appendChild(scene);
    const { container } = render(<HomeV8Client data={DATA} weather={weather} />);
    const tile = container.querySelector<HTMLElement>('a[href="/weather"]');
    if (!tile) throw new Error('плитки погоды на главной нет');
    return { tile, done: () => scene.remove() };
  }
  const color = (el: Element | null) => (el ? getComputedStyle(el).color : 'нет элемента');

  it.each([
    ['ночь', NIGHT, 'night-clear'],
    ['день', OK, 'day-cloud'],
  ])('%s: температура, небо, дни и предупреждение — цветом сцены', (_n, w, sceneName) => {
    const { tile, done } = home(homeWeatherFrom(w, WARN, NOW));
    expect(tile.getAttribute('data-wx-scene')).toBe(sceneName);
    expect(color(tile)).toBe('var(--wx-fg)');
    for (const sel of ['.hw-temp', '.hw-mid b', '.hw-day b', '.hw-warn-t']) {
      expect([sel, color(tile.querySelector(sel))]).toEqual([sel, 'var(--wx-fg)']);
    }
    // Кромка и знак предупреждения — оттенком сцены, а не --warning страницы.
    expect(color(tile.querySelector('.hw-warn svg'))).toBe('var(--wx-warn)');
    expect(getComputedStyle(tile.querySelector('.hw-warn')!).boxShadow).toContain('var(--wx-warn)');
    // Строки — над силуэтом гряды, а не под ним.
    for (const sel of ['.hw-cap', '.hw-row', '.hw-warn']) {
      const st = getComputedStyle(tile.querySelector(sel)!);
      expect([sel, st.position, st.zIndex]).toEqual([sel, 'relative', '1']);
    }
    expect(getComputedStyle(tile.querySelector('.hw-hills')!).zIndex).toBe('0');
    done();
  });

  it('у сцены есть оттенок предупреждения для ночи и для дня', () => {
    const night = SCENE_CSS.slice(SCENE_CSS.indexOf('.wx-scene {'), SCENE_CSS.indexOf('}'));
    const dayStart = SCENE_CSS.indexOf('.wx-scene[data-wx-scene="day-clear"],');
    const day = SCENE_CSS.slice(dayStart, SCENE_CSS.indexOf('}', dayStart));
    expect(night).toMatch(/--wx-warn:\s*#/);
    expect(day).toMatch(/--wx-warn:\s*#/);
  });

  it('прогноза нет — сцены нет, и плитка пишет цветами страницы', () => {
    const { tile, done } = home({ kind: 'failed' });
    expect(tile.classList.contains('wx-scene')).toBe(false);
    expect(color(tile)).toBe('var(--text-primary)');
    done();
  });
});
