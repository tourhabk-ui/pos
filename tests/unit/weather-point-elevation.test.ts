// @vitest-environment node
/**
 * Сторож #2249 (07.10): прогноз называет свою точку и её высоту, город —
 * центром города, а отказ источника — последним удачным прогнозом с отметкой.
 *
 * Повод — разбор MCP-ответа: «Авачинский: −15…−9°C, снег» читался прогнозом
 * похода, хотя это 2700 м, а у подножия около нуля; «Петропавловск» уходил в
 * первое место со словом в имени («Вид на Петропавловск-Камчатский»); 429
 * Open-Meteo оставлял без прогноза вовсе, хотя час назад он был.
 *
 * Держится:
 * 1. высота точки из ответа Open-Meteo доходит до текста; выше 500 м — прямое
 *    предупреждение, что ниже иначе;
 * 2. запрос о городе не идёт в справочник мест;
 * 3. отказ после удачи — тот же прогноз с staleSince, и отказ всё равно в логе;
 *    без прежней удачи — честный ok:false.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));

const { pool } = await import('@/lib/db-pool');
const { fetchForecastDays } = await import('@/lib/planner/intelligence');
const { isCityQuery, elevationNote, resolvePlaceCoords, weatherForKuzmich, DEFAULT_WEATHER_PLACE } =
  await import('@/lib/kuzmich/weather-tool');

const q = pool.query as unknown as ReturnType<typeof vi.fn>;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); q.mockReset(); });

const okBody = (elevation: unknown) => JSON.stringify({
  elevation,
  daily: {
    time: ['2026-10-07'],
    temperature_2m_max: [-9], temperature_2m_min: [-15], precipitation_sum: [4],
    wind_speed_10m_max: [60], weather_code: [73],
  },
});

describe('город — центром города', () => {
  it('«Петропавловск» и его формы — город', () => {
    for (const s of ['Петропавловск', 'петропавловск-камчатский', 'г. Петропавловск-Камчатский',
      'Петропавловск Камчатский', 'Петропавловск-Камчатском', 'ПК']) {
      expect(isCityQuery(s), s).toBe(true);
    }
  });

  it('место со словом в имени — не город', () => {
    expect(isCityQuery('Вид на Петропавловск-Камчатский')).toBe(false);
    expect(isCityQuery('Мутновский')).toBe(false);
  });

  it('запрос о городе не идёт в справочник мест', async () => {
    const p = await resolvePlaceCoords('Петропавловск');
    expect(p).toEqual(DEFAULT_WEATHER_PLACE);
    expect(q).not.toHaveBeenCalled();
  });

  it('точное имя места — первым, а не самое короткое со словом', () => {
    const src = readFileSync('lib/kuzmich/weather-tool.ts', 'utf8');
    expect(src).toMatch(/ORDER BY \(lower\(name\) = lower\(\$2\)\) DESC, length\(name\) ASC/);
  });
});

describe('высота точки прогноза', () => {
  it('ниже 500 м — просто названа', () => {
    expect(elevationNote(46)).toBe(', высота точки ~50 м');
  });

  it('выше 500 м — прямое предупреждение, что ниже иначе', () => {
    expect(elevationNote(2741)).toMatch(/~2740 м — прогноз для этой высоты, ниже теплее/);
  });

  it('высоты нет — ничего не придумано', () => {
    expect(elevationNote(null)).toBe('');
    expect(elevationNote(undefined)).toBe('');
  });

  it('загрузчик берёт elevation из ответа Open-Meteo; не число — null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(okBody(2741.4), { status: 200 })));
    const r = await fetchForecastDays(53.26, 158.83, 1);
    expect(r.ok && r.elevationM).toBe(2741);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(okBody('nan'), { status: 200 })));
    const r2 = await fetchForecastDays(53.27, 158.84, 1);
    expect(r2.ok && r2.elevationM).toBeNull();
  });

  it('высота доходит до ответа инструмента', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(okBody(2741), { status: 200 })));
    const out = await weatherForKuzmich({ lat: '53.30', lng: '158.85', days: '1' });
    expect(out.split('\n')[0]).toContain('высота точки ~2740 м — прогноз для этой высоты');
  });
});

describe('отказ источника после удачи', () => {
  it('429 после удачного прогноза — тот же прогноз с отметкой, отказ в логе', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T00:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(okBody(900), { status: 200 })));
    const first = await fetchForecastDays(52.11, 158.11, 1);
    expect(first.ok && first.staleSince).toBeUndefined();

    // Кэш (3 ч) истёк, источник отвечает 429.
    vi.setSystemTime(new Date('2026-10-07T04:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('rate', { status: 429 })));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const second = await fetchForecastDays(52.11, 158.11, 1);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.staleSince).toBe('2026-10-07T00:00:00.000Z');
    expect(second.days[0].tempMin).toBe(-15);
    expect(err).toHaveBeenCalled();
  });

  it('прошлой удаче больше суток — честный отказ, а не старьё', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T00:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(okBody(900), { status: 200 })));
    await fetchForecastDays(52.12, 158.12, 1);

    vi.setSystemTime(new Date('2026-10-08T01:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('rate', { status: 429 })));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await fetchForecastDays(52.12, 158.12, 1);
    expect(r).toEqual({ ok: false, reason: 'Open-Meteo HTTP 429' });
  });

  it('устаревший прогноз назван в ответе инструмента', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T00:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(okBody(100), { status: 200 })));
    await weatherForKuzmich({ lat: '52.13', lng: '158.13', days: '1' });

    vi.setSystemTime(new Date('2026-10-07T05:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('rate', { status: 429 })));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await weatherForKuzmich({ lat: '52.13', lng: '158.13', days: '1' });
    expect(out).toMatch(/источник сейчас не отвечает — это последний полученный прогноз, от 7 октября/);
  });
});
