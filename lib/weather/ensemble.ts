/**
 * lib/weather/ensemble.ts
 *
 * Вероятностный прогноз для тревог: ансамбль Google **WeatherNext 2** через
 * Open-Meteo Ensemble API. Находка #1787 звала WeatherNext 3; вот что
 * выяснилось при разборе (замеры 10.09 с раннера, не по памяти).
 *
 * У САМОЙ WN3 REST-API «ключ + GET JSON» нет: прогнозы отдаются данными на
 * Google Cloud (GCS Zarr, BigQuery, Earth Engine) по allowlist-заявке, бакеты
 * Requester Pays — нужен billing-проект GCP, а чтение Zarr — питоновский
 * стек, не наш. Второй путь к WN3 — Google Maps Platform Weather API: платный
 * REST с ключом и, что важнее, ХОСТ GOOGLE: Gemini с прода Timeweb уже
 * гео-блокируется (§8), и ставить на такой хост safety-путь нельзя.
 *
 * Поэтому взят третий путь, доступный сегодня и бесплатно: Open-Meteo отдаёт
 * ансамбль предыдущего поколения той же линейки — `google_weathernext2_ensemble`.
 * Хост Open-Meteo мы уже используем для детерминированного прогноза
 * (`lib/planner/intelligence.ts`), то есть новой сетевой зависимости не
 * появляется — появляется новая ВЕЛИЧИНА.
 *
 * ЗАЧЕМ ЭТО ВООБЩЕ. Детерминированный прогон отвечает «дождь» или «не дождь»
 * и не умеет сказать «не знаю» — это §4.0 на уровне прогноза: угроза с
 * вероятностью 40 % доходит до оператора как «угроз нет». Ансамбль — 63
 * члена, и их согласие измеримо: «41 из 63 видят опасность» это не то же
 * самое, что «3 из 63», хотя детерминированный прогон в обоих случаях мог
 * сказать одно и то же.
 *
 * ЧТО МОДЕЛЬ ОТДАЁТ, А ЧТО НЕТ (замер 10.09, Петропавловск, 5 суток):
 *   значениями — temperature_2m, wind_speed_10m, precipitation, snowfall,
 *                weather_code (63 члена: member01..member63);
 *   ключи есть, значения null — wind_gusts_10m, visibility.
 * Порывы и видимость поэтому НЕ участвуют в счёте и названы отсутствующими
 * (`unavailable`): «не мерили» не равно «безопасно». Число членов читается из
 * ответа, а не зашито: 63 — замер, а не контракт.
 */

import { DANGEROUS_WMO_CODES } from '@/lib/weather/wmo-hazard';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

export const ENSEMBLE_ENDPOINT = 'https://ensemble-api.open-meteo.com/v1/ensemble';
export const ENSEMBLE_MODEL = 'google_weathernext2_ensemble';
export const ENSEMBLE_MODEL_LABEL = 'ансамбль WeatherNext 2';
const ENSEMBLE_TZ = 'Asia/Kamchatka';

/** Виды угроз, которые ансамбль этой модели способен подтвердить значениями. */
export type HazardKind = 'wind' | 'precipitation' | 'snowfall' | 'weather_code';

/** Переменная Open-Meteo под каждым видом угрозы. */
export const HAZARD_VARS: Record<HazardKind, string> = {
  wind: 'wind_speed_10m',
  precipitation: 'precipitation',
  snowfall: 'snowfall',
  weather_code: 'weather_code',
};

/**
 * Переменные, которые у модели просят ради полноты, но которые она отдаёт
 * пустыми. Спрашиваются намеренно: если завтра значения появятся, это будет
 * видно по пустому `unavailable`, а не по чьей-то памяти.
 */
export const PROBED_EMPTY_VARS = ['wind_gusts_10m', 'visibility'] as const;

/**
 * Пороги «час опасен». Взяты из шкалы `calculateSafetyLevel`
 * (`app/api/weather/route.ts`): 40 км/ч — граница `difficult`, при которой там
 * же печатается «очень сильный ветер, ограничения для горных туров».
 * Осадки и снег — часовые, не суточные: ансамбль почасовой.
 */
export const HAZARD_THRESHOLDS = {
  windKmh: 40,
  precipMmPerHour: 4,
  snowfallCmPerHour: 1,
} as const;

/** Согласие членов ансамбля. `unknown` — третий исход, не «спокойно». */
export type Consensus = 'danger' | 'split' | 'calm' | 'unknown';

export interface EnsembleDay {
  /** Дата в зоне запроса (Asia/Kamchatka), YYYY-MM-DD. */
  date: string;
  /** Членов с пригодными данными за день. 0 — про день не известно ничего. */
  membersCounted: number;
  /** Сколько из них видят опасность хотя бы в один час. null при нуле выше. */
  membersDangerous: number | null;
  /** Доля 0..1. null — считать было из чего: см. membersCounted. */
  share: number | null;
  consensus: Consensus;
  /** Разбивка по видам угроз; null, когда день неизвестен. */
  byHazard: Record<HazardKind, number> | null;
}

export interface EnsembleOutlook {
  model: string;
  /** Членов в ответе — читается из ответа, не зашито. */
  members: number;
  days: EnsembleDay[];
  /**
   * Переменные, которые спросили, а получили пустыми. Не «в порядке» и не
   * «опасности нет» — «этой величины у модели нет».
   */
  unavailable: string[];
}

/** Что сказать, когда ансамбль не ответил вовсе. */
export const ENSEMBLE_UNAVAILABLE_NOTE =
  `${ENSEMBLE_MODEL_LABEL} недоступен — уверенность прогноза неизвестна`;

// ── Чистый разбор ответа ────────────────────────────────────────────────────

type Series = (number | null)[];

function asSeries(value: unknown): Series | null {
  if (!Array.isArray(value)) return null;
  return value.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((v) => typeof v === 'string') ? (value as string[]) : null;
}

function isHazardValue(kind: HazardKind, value: number): boolean {
  switch (kind) {
    case 'wind': return value >= HAZARD_THRESHOLDS.windKmh;
    case 'precipitation': return value >= HAZARD_THRESHOLDS.precipMmPerHour;
    case 'snowfall': return value >= HAZARD_THRESHOLDS.snowfallCmPerHour;
    case 'weather_code': return DANGEROUS_WMO_CODES.has(Math.round(value));
  }
}

/** Согласие по доле членов, видящих опасность. Границы — трети. */
export function consensusOf(share: number | null): Consensus {
  if (share === null) return 'unknown';
  if (share >= 2 / 3) return 'danger';
  if (share >= 1 / 3) return 'split';
  return 'calm';
}

/**
 * Разбор ответа Ensemble API. `null` — ответ не той формы или ни одного
 * члена с данными: это ОТКАЗ, а не спокойный прогноз.
 */
export function parseEnsemble(json: unknown): EnsembleOutlook | null {
  if (typeof json !== 'object' || json === null) return null;
  const hourly = (json as { hourly?: unknown }).hourly;
  if (typeof hourly !== 'object' || hourly === null) return null;
  const table = hourly as Record<string, unknown>;

  const times = asStringArray(table.time);
  if (!times || times.length === 0) return null;

  // Серии по видам угроз: вид → член → часы.
  const byKind = new Map<HazardKind, Map<string, Series>>();
  const memberIds = new Set<string>();
  const unavailable: string[] = [];

  const collect = (variable: string): Map<string, Series> => {
    const found = new Map<string, Series>();
    const re = new RegExp(`^${variable}_member(\\d+)$`);
    let keysSeen = 0;
    for (const [key, value] of Object.entries(table)) {
      const m = re.exec(key);
      if (!m) continue;
      keysSeen += 1;
      const series = asSeries(value);
      if (!series) continue;
      if (series.some((v) => v !== null)) found.set(m[1], series);
    }
    // Ключи пришли, а значений нет ни у кого — величины у модели нет.
    if (keysSeen > 0 && found.size === 0) unavailable.push(variable);
    return found;
  };

  for (const kind of Object.keys(HAZARD_VARS) as HazardKind[]) {
    const series = collect(HAZARD_VARS[kind]);
    if (series.size > 0) {
      byKind.set(kind, series);
      for (const id of series.keys()) memberIds.add(id);
    }
  }
  for (const variable of PROBED_EMPTY_VARS) collect(variable);

  if (memberIds.size === 0) return null;

  // Часы по датам зоны запроса: ISO-строка вида 2026-09-10T00:00.
  const hoursByDate = new Map<string, number[]>();
  times.forEach((t, i) => {
    const date = t.slice(0, 10);
    const bucket = hoursByDate.get(date);
    if (bucket) bucket.push(i);
    else hoursByDate.set(date, [i]);
  });

  const members = [...memberIds].sort();
  const days: EnsembleDay[] = [];

  for (const [date, hours] of hoursByDate) {
    let counted = 0;
    let dangerous = 0;
    const byHazard: Record<HazardKind, number> = {
      wind: 0, precipitation: 0, snowfall: 0, weather_code: 0,
    };

    for (const member of members) {
      let hasData = false;
      const kindsHit: HazardKind[] = [];

      for (const [kind, series] of byKind) {
        const values = series.get(member);
        if (!values) continue;
        let hit = false;
        for (const h of hours) {
          const v = values[h];
          if (v === null || v === undefined) continue;
          hasData = true;
          if (isHazardValue(kind, v)) hit = true;
        }
        if (hit) kindsHit.push(kind);
      }

      if (!hasData) continue;
      counted += 1;
      if (kindsHit.length > 0) {
        dangerous += 1;
        for (const kind of kindsHit) byHazard[kind] += 1;
      }
    }

    const share = counted > 0 ? dangerous / counted : null;
    days.push({
      date,
      membersCounted: counted,
      membersDangerous: counted > 0 ? dangerous : null,
      share,
      consensus: consensusOf(share),
      byHazard: counted > 0 ? byHazard : null,
    });
  }

  return {
    model: ENSEMBLE_MODEL,
    members: members.length,
    days,
    unavailable: [...new Set(unavailable)].sort(),
  };
}

/** День прогноза по дате брони. `null` — этого дня в горизонте ансамбля нет. */
export function ensembleDayFor(
  outlook: EnsembleOutlook | null,
  date: string | Date,
): EnsembleDay | null {
  if (!outlook) return null;
  const iso = isoDate(date);
  if (!iso) return null;
  return outlook.days.find((d) => d.date === iso) ?? null;
}

/**
 * Дата как YYYY-MM-DD. Колонка `booking_date` типа `date`: node-postgres
 * отдаёт её то строкой, то Date (локальная полночь) — второй случай нельзя
 * гонять через toISOString, там дата уезжает на сутки назад при TZ впереди UTC.
 */
export function isoDate(value: string | Date): string | null {
  if (typeof value === 'string') {
    return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
  }
  if (Number.isNaN(value.getTime())) return null;
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const HAZARD_NAMES: Record<HazardKind, string> = {
  wind: `ветер от ${HAZARD_THRESHOLDS.windKmh} км/ч`,
  precipitation: `осадки от ${HAZARD_THRESHOLDS.precipMmPerHour} мм/ч`,
  snowfall: `снег от ${HAZARD_THRESHOLDS.snowfallCmPerHour} см/ч`,
  weather_code: 'опасное явление',
};

/** Виды угроз дня словами, от частой к редкой. Пустой список — угроз нет. */
export function hazardBreakdown(day: EnsembleDay): string[] {
  if (!day.byHazard) return [];
  return (Object.keys(day.byHazard) as HazardKind[])
    .filter((kind) => (day.byHazard as Record<HazardKind, number>)[kind] > 0)
    .sort((a, b) => (day.byHazard as Record<HazardKind, number>)[b]
      - (day.byHazard as Record<HazardKind, number>)[a])
    .map((kind) => `${HAZARD_NAMES[kind]} — ${(day.byHazard as Record<HazardKind, number>)[kind]}`);
}

const CONSENSUS_WORDS: Record<Consensus, string> = {
  danger: 'согласие высокое',
  split: 'члены расходятся',
  calm: 'большинство спокойно',
  unknown: 'согласие неизвестно',
};

/**
 * Уверенность прогноза словами для тревоги. `null` на входе — дня в ансамбле
 * нет, и это говорится вслух, а не заменяется тишиной.
 */
export function describeEnsembleDay(day: EnsembleDay | null): string {
  if (!day) return ENSEMBLE_UNAVAILABLE_NOTE;
  if (day.membersDangerous === null || day.membersCounted === 0) {
    return `${ENSEMBLE_MODEL_LABEL}: данных за ${day.date} нет — уверенность неизвестна`;
  }
  return `${ENSEMBLE_MODEL_LABEL}: ${day.membersDangerous} из ${day.membersCounted} членов`
    + ` видят опасность (${CONSENSUS_WORDS[day.consensus]})`;
}

// ── Живой запрос ────────────────────────────────────────────────────────────

const TTL_OK_MS = 30 * 60 * 1000;
const TTL_FAIL_MS = 5 * 60 * 1000;
const cache = new Map<string, { data: EnsembleOutlook | null; at: number }>();

/**
 * Ансамблевый прогноз по точке. `null` — не смог: отказ сети, не-2xx, ответ
 * не той формы. Отказ пишется в лог (§4.0) и кэшируется на 5 минут, чтобы
 * двадцать броней одной зоны не превратились в двадцать таймаутов.
 */
export async function fetchEnsembleOutlook(
  lat: number,
  lng: number,
  days: number,
): Promise<EnsembleOutlook | null> {
  const horizon = Math.max(1, Math.min(15, Math.round(days)));
  const key = `${lat.toFixed(2)},${lng.toFixed(2)},${horizon}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.data ? TTL_OK_MS : TTL_FAIL_MS)) return hit.data;

  const variables = [
    ...Object.values(HAZARD_VARS),
    ...PROBED_EMPTY_VARS,
  ].join(',');
  const url = `${ENSEMBLE_ENDPOINT}?latitude=${lat}&longitude=${lng}`
    + `&hourly=${variables}&models=${ENSEMBLE_MODEL}`
    + `&forecast_days=${horizon}&timezone=${ENSEMBLE_TZ}`;

  let outlook: EnsembleOutlook | null = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
    if (!res.ok) {
      logSwallowedFailure('weather', `${ENSEMBLE_MODEL_LABEL} (HTTP ${res.status})`,
        new Error(`ensemble HTTP ${res.status}`));
    } else {
      outlook = parseEnsemble(await res.json());
      if (!outlook) {
        logSwallowedFailure('weather', `${ENSEMBLE_MODEL_LABEL}: ответ не той формы`,
          new Error('ensemble shape'));
      }
    }
  } catch (err) {
    logSwallowedFailure('weather', ENSEMBLE_MODEL_LABEL, err);
  }

  cache.set(key, { data: outlook, at: Date.now() });
  return outlook;
}
