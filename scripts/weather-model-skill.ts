/**
 * Замер моделей Open-Meteo для побережья Камчатки (#2249) — с раннера GitHub.
 *
 * Песочница агента до Open-Meteo и NOAA не достаёт (прокси), раннер —
 * достаёт. Только чтение: ни прод, ни база не участвуют, ключей не нужно.
 *
 * Что делает:
 *  1. находит метеостанцию GHCN-Daily по имени из маркера (печатает
 *     кандидатов с расстоянием до точки) — номер станции не угадывается;
 *  2. берёт фактические суточные осадки станции за окно маркера;
 *  3. по каждой модели берёт прогноз на сутки вперёд (Previous Runs API,
 *     `precipitation_previous_day1`) и для справки — самый свежий прогон
 *     (`precipitation`); считает «сухо / осадки», ложные «ливни», смещение;
 *  4. проверяет, в какие сутки станция пишет осадки (местные или UTC), —
 *     по тому, при каком сдвиге модели совпадают с фактом лучше;
 *  5. для лидеров спрашивает ровно тот прогноз, что берёт `get_weather`
 *     (`lib/planner/intelligence.ts`), с `models=` — и считает пустые поля:
 *     модель, у которой нет снега или дальних дней, сломала бы прогноз
 *     молча.
 *
 * Счёт — `lib/weather/model-skill.ts` (под тестами). Ноль дней факта или ни
 * одной модели в рейтинге — код выхода 1: «не смог сравнить» не равно
 * «все одинаковы».
 *
 *   npx tsx scripts/weather-model-skill.ts
 */
import { readFileSync, appendFileSync } from 'fs';
import {
  dailySums, scoreForecast, rankModels, pickDayConvention,
  KAMCHATKA_UTC_OFFSET_H, MIN_COMPARED_DAYS, type SkillScore,
} from '@/lib/weather/model-skill';
import { distanceKm } from '@/lib/geo/kamchatka';

interface Marker {
  run: number;
  point: { name: string; lat: number; lng: number };
  stationSearch: string[];
  station?: string | null;
  days: number;
  models: string[];
  wetMm: number[];
  heavyMm?: number;
  forecastDays?: number;
}

const MARKER_PATH = '.github/triggers/weather-model-skill.json';
const STATIONS_TXT = 'https://www.ncei.noaa.gov/pub/data/ghcn/daily/ghcnd-stations.txt';
const NCEI = 'https://www.ncei.noaa.gov/access/services/data/v1';
const PREV_RUNS = 'https://previous-runs-api.open-meteo.com/v1/forecast';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
/** Те же переменные, что запрашивает fetchForecastDays. */
const PROD_DAILY = ['temperature_2m_max', 'temperature_2m_min', 'precipitation_sum', 'wind_speed_10m_max', 'weather_code'];
const PROD_HOURLY = ['temperature_2m', 'precipitation', 'snowfall', 'wind_speed_10m'];

const summary: string[] = [];
function out(line = ''): void {
  console.log(line);
  summary.push(line);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string, timeoutMs = 60_000): Promise<{ status: number; text: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      if (res.status === 429 && attempt === 0) { await sleep(5000); continue; }
      return { status: res.status, text };
    } catch (err) {
      if (attempt === 1) return { status: 0, text: err instanceof Error ? err.message : String(err) };
      await sleep(3000);
    }
  }
  return { status: 0, text: 'unreachable' };
}

function isoDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

function fmt(x: number | null, digits = 2): string {
  return x === null ? '—' : x.toFixed(digits);
}

interface Station { id: string; lat: number; lng: number; elev: number | null; name: string; wmo: string; km: number }

async function findStations(m: Marker): Promise<Station[]> {
  const r = await get(STATIONS_TXT, 120_000);
  if (r.status !== 200) throw new Error(`список станций GHCN: HTTP ${r.status}`);
  const terms = m.stationSearch.map((s) => s.toUpperCase());
  const found: Station[] = [];
  for (const l of r.text.split('\n')) {
    const name = l.slice(41, 71).trim();
    if (!terms.some((t) => name.includes(t))) continue;
    const lat = Number(l.slice(12, 20));
    const lng = Number(l.slice(21, 30));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const elev = Number(l.slice(31, 37));
    found.push({
      id: l.slice(0, 11).trim(), lat, lng, name, wmo: l.slice(80, 85).trim(),
      elev: Number.isFinite(elev) && elev > -999 ? elev : null,
      km: Math.round(distanceKm(m.point, { lat, lng }) * 10) / 10,
    });
  }
  return found.sort((a, b) => a.km - b.km);
}

async function fetchObs(station: string, start: string, end: string): Promise<{ obs: Map<string, number>; attrs: string[] }> {
  const url = `${NCEI}?dataset=daily-summaries&stations=${station}&startDate=${start}&endDate=${end}&dataTypes=PRCP&format=json&units=metric&includeAttributes=true`;
  const r = await get(url, 120_000);
  if (r.status !== 200) throw new Error(`факт станции ${station}: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  const rows = JSON.parse(r.text) as Array<{ DATE?: string; PRCP?: string; PRCP_ATTRIBUTES?: string }>;
  const obs = new Map<string, number>();
  const attrs = new Set<string>();
  for (const row of rows) {
    const v = Number(row.PRCP);
    if (!row.DATE || row.PRCP === undefined || row.PRCP.trim() === '' || !Number.isFinite(v)) continue;
    obs.set(row.DATE.slice(0, 10), v);
    if (row.PRCP_ATTRIBUTES !== undefined) attrs.add(row.PRCP_ATTRIBUTES);
  }
  return { obs, attrs: [...attrs].slice(0, 6) };
}

interface ModelSeries {
  model: string;
  error?: string;
  day1Local?: Map<string, number>;
  day1Utc?: Map<string, number>;
  day0Local?: Map<string, number>;
  day0Utc?: Map<string, number>;
}

async function fetchModel(m: Marker, model: string, start: string, end: string): Promise<ModelSeries> {
  const url = `${PREV_RUNS}?latitude=${m.point.lat}&longitude=${m.point.lng}&hourly=precipitation,precipitation_previous_day1&models=${model}&start_date=${start}&end_date=${end}&timezone=GMT`;
  const r = await get(url);
  if (r.status !== 200) {
    let reason = r.text.slice(0, 200);
    try { reason = String((JSON.parse(r.text) as { reason?: unknown }).reason ?? reason); } catch { /* тело не JSON — печатаем как есть */ }
    return { model, error: `HTTP ${r.status}: ${reason}` };
  }
  const j = JSON.parse(r.text) as { hourly?: { time?: string[]; precipitation?: Array<number | null>; precipitation_previous_day1?: Array<number | null> } };
  const h = j.hourly;
  if (!h?.time) return { model, error: 'ответ без hourly.time' };
  const day1 = h.precipitation_previous_day1 ?? [];
  const day0 = h.precipitation ?? [];
  return {
    model,
    day1Local: dailySums(h.time, day1, KAMCHATKA_UTC_OFFSET_H),
    day1Utc: dailySums(h.time, day1, 0),
    day0Local: dailySums(h.time, day0, KAMCHATKA_UTC_OFFSET_H),
    day0Utc: dailySums(h.time, day0, 0),
  };
}

interface Completeness { model: string; error?: string; lastPrecipDay?: string | null; gaps: string[] }

async function prodCompleteness(m: Marker, model: string): Promise<Completeness> {
  const days = m.forecastDays ?? 16;
  const url = `${FORECAST}?latitude=${m.point.lat}&longitude=${m.point.lng}&daily=${PROD_DAILY.join(',')}&hourly=${PROD_HOURLY.join(',')}&forecast_days=${days}&timezone=Asia/Kamchatka&models=${model}`;
  const r = await get(url);
  if (r.status !== 200) return { model, error: `HTTP ${r.status}: ${r.text.slice(0, 160)}`, gaps: [] };
  const j = JSON.parse(r.text) as { daily?: Record<string, unknown[]>; hourly?: Record<string, unknown[]> };
  const gaps: string[] = [];
  const nulls = (arr: unknown[] | undefined) => (arr ?? []).filter((v) => typeof v !== 'number').length;
  for (const k of PROD_DAILY) {
    const n = nulls(j.daily?.[k]);
    if (!j.daily?.[k]) gaps.push(`daily.${k}: нет поля`); else if (n) gaps.push(`daily.${k}: пусто ${n} из ${j.daily[k].length}`);
  }
  for (const k of PROD_HOURLY) {
    const n = nulls(j.hourly?.[k]);
    if (!j.hourly?.[k]) gaps.push(`hourly.${k}: нет поля`); else if (n) gaps.push(`hourly.${k}: пусто ${n} из ${j.hourly[k].length}`);
  }
  const times = (j.daily?.time ?? []) as string[];
  const precip = j.daily?.precipitation_sum ?? [];
  let lastPrecipDay: string | null = null;
  times.forEach((t, i) => { if (typeof precip[i] === 'number') lastPrecipDay = t; });
  return { model, lastPrecipDay, gaps };
}

async function main(): Promise<number> {
  const m = JSON.parse(readFileSync(MARKER_PATH, 'utf8')) as Marker;
  const mainWet = m.wetMm.includes(1) ? 1 : m.wetMm[0];
  out(`## Замер моделей погоды — прогон ${m.run}`);
  out(`Точка: ${m.point.name} (${m.point.lat}, ${m.point.lng}); окно ${m.days} дн.; порог «осадки» ${mainWet} мм/сутки.`);
  out();

  // 1. Станция
  const stations = await findStations(m);
  out('### Станции GHCN-Daily по имени');
  if (!stations.length) { out(`::error:: станций по «${m.stationSearch.join(', ')}» не найдено`); return 1; }
  for (const s of stations.slice(0, 8)) out(`- ${s.id} · ${s.name} · ${s.lat}, ${s.lng} · ${s.elev ?? '?'} м · WMO ${s.wmo || '—'} · ${s.km} км от точки`);
  const station = m.station ?? stations[0].id;
  out(`Сравниваем со станцией **${station}**.`);
  out();

  // 2. Факт
  const end = Date.now();
  const start = end - m.days * 86_400_000;
  const { obs, attrs } = await fetchObs(station, isoDay(start), isoDay(end));
  const obsDays = [...obs.keys()].sort();
  out('### Факт');
  if (!obsDays.length) { out(`::error:: у станции ${station} нет осадков за окно — сравнивать не с чем`); return 1; }
  const wetObs = [...obs.values()].filter((v) => v >= mainWet).length;
  out(`${obsDays.length} дней с ${obsDays[0]} по ${obsDays[obsDays.length - 1]}; с осадками ≥ ${mainWet} мм — ${wetObs}.`);
  out(`Флаги PRCP (образцы): ${attrs.map((a) => `«${a}»`).join(' ') || '—'}`);
  out();

  // 3. Модели — с запасом на день по краям, чтобы сдвиг суток не обрезал окно.
  const fStart = isoDay(Date.parse(`${obsDays[0]}T00:00Z`) - 86_400_000);
  const fEnd = isoDay(Math.min(end, Date.parse(`${obsDays[obsDays.length - 1]}T00:00Z`) + 86_400_000));
  const series: ModelSeries[] = [];
  for (const model of m.models) {
    series.push(await fetchModel(m, model, fStart, fEnd));
    await sleep(700);
  }
  const failed = series.filter((s) => s.error);
  if (failed.length) {
    out('### Модели без данных Previous Runs');
    for (const s of failed) out(`- ${s.model}: ${s.error}`);
    out();
  }
  const okSeries = series.filter((s) => !s.error);

  // 4. Граница суток станции
  const conv = pickDayConvention(
    okSeries.map((s) => scoreForecast(obs, s.day1Local as Map<string, number>, { wetMm: mainWet })),
    okSeries.map((s) => scoreForecast(obs, s.day1Utc as Map<string, number>, { wetMm: mainWet })),
  );
  const useUtc = conv === 'utc';
  out(`### Граница суток станции: ${conv === 'local' ? 'местные сутки' : conv === 'utc' ? 'сутки UTC' : 'не решено — считаем по местным (о них говорит пост)'}`);
  out();

  // 5. Рейтинг по каждому порогу
  let bestModels: string[] = [];
  for (const wet of m.wetMm) {
    const scored = okSeries.map((s) => ({
      model: s.model,
      score: scoreForecast(obs, (useUtc ? s.day1Utc : s.day1Local) as Map<string, number>, { wetMm: wet, heavyMm: m.heavyMm ?? 10 }),
    }));
    const { ranked, insufficient } = rankModels(scored);
    out(`### Прогноз на сутки вперёд, порог ${wet} мм`);
    out('| модель | дней | верно «сухо/осадки» | поймано дождливых | ложных среди «осадки» | ложных «ливней» | смещение, мм | ошибка, мм |');
    out('|---|---|---|---|---|---|---|---|');
    for (const r of ranked) {
      const s: SkillScore = r.score;
      out(`| ${r.model} | ${s.n} | ${fmt(s.accuracy, 3)} | ${fmt(s.pod, 3)} | ${fmt(s.far, 3)} | ${s.falseHeavy} | ${fmt(s.biasMm)} | ${fmt(s.maeMm)} |`);
    }
    if (insufficient.length) out(`Меньше ${MIN_COMPARED_DAYS} дней, не в рейтинге: ${insufficient.map((r) => `${r.model} (${r.score.n})`).join(', ')}`);
    out();
    if (wet === mainWet) bestModels = ranked.map((r) => r.model);
  }

  // Справка: свежий прогон (почти анализ) — потолок того, что модель вообще может.
  out(`### Для справки: самый свежий прогон, порог ${mainWet} мм`);
  for (const s of okSeries) {
    const sc = scoreForecast(obs, (useUtc ? s.day0Utc : s.day0Local) as Map<string, number>, { wetMm: mainWet });
    out(`- ${s.model}: дней ${sc.n}, верно ${fmt(sc.accuracy, 3)}, смещение ${fmt(sc.biasMm)} мм`);
  }
  out();

  // 6. Полнота боевого запроса у лидеров и у нынешнего best_match
  const toCheck = [...new Set([...bestModels.slice(0, 4), 'best_match'])];
  out(`### Боевой запрос get_weather с models= (горизонт ${m.forecastDays ?? 16} дн.)`);
  for (const model of toCheck) {
    const c = await prodCompleteness(m, model);
    if (c.error) out(`- ${model}: ${c.error}`);
    else out(`- ${model}: осадки до ${c.lastPrecipDay ?? '—'}; ${c.gaps.length ? `пустые поля: ${c.gaps.join('; ')}` : 'все поля заполнены'}`);
    await sleep(700);
  }

  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
  if (!bestModels.length) { console.log(`::error:: ни одна модель не набрала ${MIN_COMPARED_DAYS} дней сравнения`); return 1; }
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.log(`::error:: замер не состоялся: ${err instanceof Error ? err.message : String(err)}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
  process.exit(1);
});
