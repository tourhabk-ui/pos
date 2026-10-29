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
 * 4. одновременные запросы одной точки и горизонта — один запрос к источнику,
 *    и после исхода загрузки точка не заперта (ловушка MCP weather-rate, 29.10);
 * 5. короткий горизонт берётся из длинного прогноза той же точки срезом — дни
 *    и часы только своих дат, момент прогноза исходный; длинное из короткого
 *    не собирается; запас длиннее запрошенного годится с его моментом и
 *    пределом суток.
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

/** Ответ Open-Meteo на n дней с почасовым рядом: день i — tempMax i, час — температура i. */
const weekBody = (start: string, n: number) => {
  const dates = Array.from({ length: n }, (_, i) =>
    new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
  const times = dates.flatMap((d) => Array.from({ length: 24 }, (_, h) => `${d}T${String(h).padStart(2, '0')}:00`));
  return JSON.stringify({
    elevation: 650,
    daily: {
      time: dates,
      temperature_2m_max: dates.map((_, i) => i), temperature_2m_min: dates.map((_, i) => -i),
      precipitation_sum: dates.map(() => 0), wind_speed_10m_max: dates.map(() => 10),
      weather_code: dates.map(() => 3),
    },
    hourly: {
      time: times,
      temperature_2m: times.map((_, i) => i),
      precipitation: times.map(() => 0),
      weather_code: times.map(() => 3),
    },
  });
};

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
    expect(r).toEqual({ ok: false, reason: 'источник прогноза ответил ошибкой (HTTP 429)' });
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

describe('склейка одновременных запросов', () => {
  it('три одновременных вызова об одной точке и горизонте — один запрос к источнику', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchMock = vi.fn(() => gate.then(() => new Response(weekBody('2026-10-29', 3), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const all = Promise.all([
      fetchForecastDays(52.21, 158.21, 3),
      fetchForecastDays(52.21, 158.21, 3),
      weatherForKuzmich({ lat: '52.21', lng: '158.21', days: '3' }),
    ]);
    await new Promise((r) => setTimeout(r, 0));
    release();
    const [a, b, text] = await all;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.days).toEqual(a.days);
    expect(a.days).toHaveLength(3);
    expect(text).toContain('Прогноз Open-Meteo для «точка 52.21, 158.21»');
    expect(text).not.toContain('ПОГОДА НЕДОСТУПНА');
  });

  it('после удачи и срока кэша точка снова идёт к источнику, а не к старой загрузке', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T00:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(weekBody('2026-10-29', 3), { status: 200 })));
    await fetchForecastDays(52.22, 158.22, 3);

    vi.setSystemTime(new Date('2026-10-29T03:01:00Z'));
    const again = vi.fn().mockResolvedValueOnce(new Response(weekBody('2026-10-29', 3), { status: 200 }));
    vi.stubGlobal('fetch', again);
    const r = await fetchForecastDays(52.22, 158.22, 3);
    expect(again).toHaveBeenCalledTimes(1);
    expect(r.ok && r.fetchedAt).toBe('2026-10-29T03:01:00.000Z');
  });

  it('после отказа и его срока (5 мин) точка снова идёт к источнику', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T00:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await fetchForecastDays(52.23, 158.23, 3);
    expect(failed).toEqual({ ok: false, reason: 'нет связи с источником прогноза' });

    vi.setSystemTime(new Date('2026-10-29T00:06:00Z'));
    const again = vi.fn().mockResolvedValueOnce(new Response(weekBody('2026-10-29', 3), { status: 200 }));
    vi.stubGlobal('fetch', again);
    const r = await fetchForecastDays(52.23, 158.23, 3);
    expect(again).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
  });
});

describe('короткий горизонт из длинного прогноза', () => {
  it('прогноз на 7 дней отвечает на 3 срезом: три дня, часы только их дат, момент исходный', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T00:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(weekBody('2026-10-29', 7), { status: 200 })));
    const week = await fetchForecastDays(52.31, 158.31, 7);
    expect(week.ok && week.days).toHaveLength(7);

    vi.setSystemTime(new Date('2026-10-29T01:00:00Z'));
    const source = vi.fn(() => { throw new Error('к источнику идти не должен'); });
    vi.stubGlobal('fetch', source);
    const r = await fetchForecastDays(52.31, 158.31, 3);
    expect(source).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.days.map((d) => d.date)).toEqual(['2026-10-29', '2026-10-30', '2026-10-31']);
    expect(r.days.map((d) => d.tempMax)).toEqual([0, 1, 2]);
    expect(r.hours).toHaveLength(72);
    expect(new Set(r.hours?.map((h) => h.time.slice(0, 10)))).toEqual(new Set(['2026-10-29', '2026-10-30', '2026-10-31']));
    expect(r.fetchedAt).toBe('2026-10-29T00:00:00.000Z');
    expect(r.staleSince).toBeUndefined();
    expect(r.elevationM).toBe(650);
  });

  it('прогноз на 3 дня не отвечает на 7: дни не дорисовываются, запрос идёт к источнику', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(weekBody('2026-10-29', 3), { status: 200 })));
    await fetchForecastDays(52.32, 158.32, 3);

    const source = vi.fn().mockResolvedValueOnce(new Response(weekBody('2026-10-29', 7), { status: 200 }));
    vi.stubGlobal('fetch', source);
    const r = await fetchForecastDays(52.32, 158.32, 7);
    expect(source).toHaveBeenCalledTimes(1);
    expect(r.ok && r.days).toHaveLength(7);
  });

  it('длинный ответ с днями меньше запрошенного короткого не служит ему срезом', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(weekBody('2026-10-29', 2), { status: 200 })));
    await fetchForecastDays(52.38, 158.38, 7);

    const source = vi.fn().mockResolvedValueOnce(new Response(weekBody('2026-10-29', 3), { status: 200 }));
    vi.stubGlobal('fetch', source);
    const r = await fetchForecastDays(52.38, 158.38, 3);
    expect(source).toHaveBeenCalledTimes(1);
    expect(r.ok && r.days).toHaveLength(3);
  });

  it('свой отказ из кэша уступает свежему длинному прогнозу той же точки', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T00:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('rate', { status: 429 })));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await fetchForecastDays(52.33, 158.33, 3);
    expect(failed.ok).toBe(false);

    vi.setSystemTime(new Date('2026-10-29T00:01:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(weekBody('2026-10-29', 7), { status: 200 })));
    await fetchForecastDays(52.33, 158.33, 7);

    vi.setSystemTime(new Date('2026-10-29T00:02:00Z'));
    const r = await fetchForecastDays(52.33, 158.33, 3);
    expect(r.ok && r.days).toHaveLength(3);
    expect(r.ok && r.staleSince).toBeUndefined();
  });

  it('отказ источника: запас на 7 дней отвечает на 3 срезом с моментом своей удачи', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T00:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(weekBody('2026-10-29', 7), { status: 200 })));
    await fetchForecastDays(52.34, 158.34, 7);

    vi.setSystemTime(new Date('2026-10-29T04:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('rate', { status: 429 })));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await fetchForecastDays(52.34, 158.34, 3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.staleSince).toBe('2026-10-29T00:00:00.000Z');
    expect(r.days).toHaveLength(3);
    expect(r.hours).toHaveLength(72);
    expect(JSON.stringify(err.mock.calls)).toMatch(/прогноз Open-Meteo \(52\.34, 158\.34\)/);
  });

  it('запас длинного горизонта не перебивает более свежий запас своего', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.setSystemTime(new Date('2026-10-29T00:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(weekBody('2026-10-29', 7), { status: 200 })));
    await fetchForecastDays(52.37, 158.37, 7);

    // Неделя протухла — три дня получены сами, позже недели.
    vi.setSystemTime(new Date('2026-10-29T03:01:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(weekBody('2026-10-29', 3), { status: 200 })));
    await fetchForecastDays(52.37, 158.37, 3);

    // Источник отказал: неделя уходит запасом от 00:00 и лежит в кэше пять минут.
    vi.setSystemTime(new Date('2026-10-29T06:02:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('rate', { status: 429 })));
    const week = await fetchForecastDays(52.37, 158.37, 7);
    expect(week.ok && week.staleSince).toBe('2026-10-29T00:00:00.000Z');

    vi.setSystemTime(new Date('2026-10-29T06:03:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('rate', { status: 429 })));
    const r = await fetchForecastDays(52.37, 158.37, 3);
    expect(r.ok && r.staleSince).toBe('2026-10-29T03:01:00.000Z');
  });

  it('запасу на 7 дней больше суток — на 3 дня честный отказ', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T00:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(weekBody('2026-10-29', 7), { status: 200 })));
    await fetchForecastDays(52.35, 158.35, 7);

    vi.setSystemTime(new Date('2026-10-30T01:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('rate', { status: 429 })));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await fetchForecastDays(52.35, 158.35, 3);
    expect(r).toEqual({ ok: false, reason: 'источник прогноза ответил ошибкой (HTTP 429)' });
  });

  it('запас из кэша не переживает сутки своей удачи, даже если отказ записан за минуту до них', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T00:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(weekBody('2026-10-29', 7), { status: 200 })));
    await fetchForecastDays(52.36, 158.36, 7);

    vi.setSystemTime(new Date('2026-10-29T23:59:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('rate', { status: 429 })));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const stale = await fetchForecastDays(52.36, 158.36, 3);
    expect(stale.ok && stale.staleSince).toBe('2026-10-29T00:00:00.000Z');

    vi.setSystemTime(new Date('2026-10-30T00:01:00Z'));
    const source = vi.fn().mockResolvedValueOnce(new Response('rate', { status: 429 }));
    vi.stubGlobal('fetch', source);
    const r = await fetchForecastDays(52.36, 158.36, 3);
    expect(source).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ ok: false, reason: 'источник прогноза ответил ошибкой (HTTP 429)' });
  });
});
