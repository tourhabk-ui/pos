// @vitest-environment node
/**
 * Осадки — из GFS, температура и ветер — из best_match (#2249, замер 08.10).
 *
 * Замер (weather-model-skill, прогон 3, 89 суток факта станции 32583) мерил
 * только «сухо / осадки»: GFS верен в 0,888 случаев, best_match — в 0,798.
 * Температуру и ветер он не мерил, а ветер у GFS в той же точке почти вдвое
 * сильнее — поэтому модели две, и каждое поле берётся у своей.
 *
 * Фикстура — настоящий ответ Open-Meteo `models=best_match,gfs_seamless`
 * (проба 722, точка Петропавловска, 09–10.10): поля приходят с суффиксом
 * модели, и в первый день модели расходятся в осадках вчетверо (3,6 мм
 * против 0,8), а в ветре — почти вдвое (45,3 против 78,4 км/ч). Взять поле
 * не у той модели — тест это видит.
 *
 * Код погоды делится: об осадках (51 и выше) — GFS, небо сухого дня — best_match.
 * Когда код брался у GFS целиком, на проде (prod-check 96) сухие дни стали
 * «туманом» там, где best_match говорил «пасмурно»; туман читает Rescue.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  fetchForecastDays, mergeForecastModels, PRECIP_MODEL, BASE_MODEL,
} from '@/lib/planner/intelligence';

type Block = Record<string, unknown[] | undefined>;
const FIXTURE = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/open-meteo-best-match-gfs-2026-10-09.json'), 'utf-8'),
) as { elevation: number; daily: Block; hourly: Block };

const DAILY_PRECIP = ['precipitation_sum', 'weather_code'];
const DAILY_BASE = ['temperature_2m_max', 'temperature_2m_min', 'wind_speed_10m_max'];
const HOURLY_PRECIP = ['precipitation', 'snowfall'];
const HOURLY_BASE = ['temperature_2m', 'wind_speed_10m'];

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('mergeForecastModels: каждое поле — у своей модели', () => {
  it('модели названы те, что выбрал замер', () => {
    expect(PRECIP_MODEL).toBe('gfs_seamless');
    expect(BASE_MODEL).toBe('best_match');
  });

  it('сутки: осадки и код осадков — GFS, небо, температура и ветер — best_match', () => {
    const d = mergeForecastModels(FIXTURE.daily, DAILY_PRECIP, DAILY_BASE)!;
    expect(d.time).toEqual(['2026-10-09', '2026-10-10']);
    expect(d.precipitation_sum).toEqual([0.8, 0]);
    // 09.10 — снегопад у GFS (85): код осадков. 10.10 сухой у обеих:
    // небо best_match (2, «переменная облачность»), а не GFS (3, «пасмурно»).
    expect(d.weather_code).toEqual([85, 2]);
    expect(d.temperature_2m_max).toEqual([7.1, 7.4]);
    expect(d.temperature_2m_min).toEqual([2.0, 3.1]);
    expect(d.wind_speed_10m_max).toEqual([45.3, 38.7]);
    // Поля с суффиксом дальше не идут: разбор видит одну модель.
    expect(Object.keys(d).some((k) => k.endsWith(`_${PRECIP_MODEL}`) || k.endsWith(`_${BASE_MODEL}`))).toBe(false);
  });

  it('часы: осадки и снег — GFS, температура и ветер — best_match', () => {
    const h = mergeForecastModels(FIXTURE.hourly, HOURLY_PRECIP, HOURLY_BASE)!;
    expect(h.time).toHaveLength(48);
    expect(h.precipitation).toEqual(FIXTURE.hourly.precipitation_gfs_seamless);
    expect(h.snowfall).toEqual(FIXTURE.hourly.snowfall_gfs_seamless);
    expect(h.temperature_2m).toEqual(FIXTURE.hourly.temperature_2m_best_match);
    expect(h.wind_speed_10m).toEqual(FIXTURE.hourly.wind_speed_10m_best_match);
  });

  it('нет значения у GFS — берётся best_match за этот же день, а не весь ряд', () => {
    const block: Block = {
      time: ['2026-10-09', '2026-10-10', '2026-10-11'],
      precipitation_sum_gfs_seamless: [0.8, null, 2.4],
      precipitation_sum_best_match: [3.6, 1.1, 0.0],
      weather_code_gfs_seamless: [85, null, 61],
      weather_code_best_match: [85, 2, 3],
    };
    const d = mergeForecastModels(block, DAILY_PRECIP, [])!;
    expect(d.precipitation_sum).toEqual([0.8, 1.1, 2.4]);
    expect(d.weather_code).toEqual([85, 2, 61]);
  });

  it('у обеих моделей пусто — пусто, а не ноль', () => {
    const block: Block = {
      time: ['2026-10-09'],
      precipitation_sum_gfs_seamless: [null],
      precipitation_sum_best_match: [null],
    };
    expect(mergeForecastModels(block, ['precipitation_sum'], [])!.precipitation_sum).toEqual([null]);
  });

  it('ряда GFS нет вовсе — ряд best_match целиком', () => {
    const block: Block = { time: ['2026-10-09'], precipitation_sum_best_match: [3.6] };
    expect(mergeForecastModels(block, ['precipitation_sum'], [])!.precipitation_sum).toEqual([3.6]);
  });

  it('ответ одной модели без суффиксов проходит как есть', () => {
    const block: Block = {
      time: ['2026-10-09'], precipitation_sum: [1.2], weather_code: [61],
      temperature_2m_max: [8], temperature_2m_min: [3], wind_speed_10m_max: [20],
    };
    expect(mergeForecastModels(block, DAILY_PRECIP, DAILY_BASE)).toEqual(block);
  });

  it('блока нет — нет и результата', () => {
    expect(mergeForecastModels(undefined, DAILY_PRECIP, DAILY_BASE)).toBeUndefined();
  });
});

describe('код погоды: об осадках — GFS, о небе — best_match', () => {
  const codes = (gfs: unknown[], best: unknown[]) =>
    mergeForecastModels(
      { time: gfs.map((_, i) => `2026-10-${String(9 + i).padStart(2, '0')}`), weather_code_gfs_seamless: gfs, weather_code_best_match: best },
      ['weather_code'], [],
    )!.weather_code;

  it('прод, зона Авачинского (prod-check 96): сухие дни — небо best_match, не «туман» GFS', () => {
    // GFS: сильный снегопад, туман, ясно, туман, пасмурно; best_match — снегопад и пасмурно.
    expect(codes([86, 45, 0, 45, 3], [86, 3, 3, 3, 3])).toEqual([86, 3, 3, 3, 3]);
  });

  it('осадки у GFS — его код, даже если best_match видел сухо', () => {
    expect(codes([61, 95, 51], [3, 2, 3])).toEqual([61, 95, 51]);
  });

  it('сухо у GFS, а best_match видел осадки — код GFS: «дождь» при нуле миллиметров был бы ссорой', () => {
    expect(codes([3, 45], [61, 80])).toEqual([3, 45]);
  });

  it('туман с изморозью (48) — небо, а не осадки', () => {
    expect(codes([48], [3])).toEqual([3]);
  });

  it('нет кода у одной модели — код другой; нет у обеих — пусто', () => {
    expect(codes([45, null, null], [null, 61, null])).toEqual([45, 61, null]);
  });
});

describe('fetchForecastDays на настоящем ответе двух моделей', () => {
  function stubFixture() {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(FIXTURE), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('просит обе модели одним запросом', async () => {
    const fetchMock = stubFixture();
    await fetchForecastDays(53.0411, 158.7701, 2);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain(`models=${BASE_MODEL},${PRECIP_MODEL}`);
    expect(url).toContain('daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,weather_code');
    expect(url).toContain('hourly=temperature_2m,precipitation,snowfall,wind_speed_10m');
  });

  it('день: миллиметры и описание — GFS, температура и ветер — best_match', async () => {
    stubFixture();
    const r = await fetchForecastDays(53.0412, 158.7702, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.elevationM).toBe(50);
    expect(r.days).toHaveLength(2);
    expect(r.days[0]).toMatchObject({
      date: '2026-10-09', precipMm: 0.8, weatherCode: 85, description: 'Снегопад',
      tempMax: 7.1, tempMin: 2.0, windKmh: 45.3,
    });
    expect(r.days[1]).toMatchObject({
      date: '2026-10-10', precipMm: 0, weatherCode: 2, description: 'Переменная облачность',
      tempMax: 7.4, tempMin: 3.1, windKmh: 38.7,
    });
  });

  it('части дня считаются из тех же моделей, что и сутки', async () => {
    stubFixture();
    const r = await fetchForecastDays(53.0413, 158.7703, 2);
    if (!r.ok) throw new Error('прогноз не разобран');
    const parts = r.days[0].parts;
    expect(parts.map((p) => p.label)).toEqual(['ночь', 'утро', 'день', 'вечер']);
    // Сумма частей — суточная сумма GFS (0,8), а не best_match (3,6).
    const precip = parts.reduce((s, p) => s + (p.precipMm ?? 0), 0);
    expect(precip).toBeCloseTo(0.8, 1);
    // Ветер частей — best_match: его максимум за сутки и есть суточный.
    const hourlyBestWind = (FIXTURE.hourly.wind_speed_10m_best_match as number[]).slice(0, 24);
    expect(Math.max(...parts.map((p) => p.windKmh ?? 0))).toBe(Math.max(...hourlyBestWind));
  });
});
