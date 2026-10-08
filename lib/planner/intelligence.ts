/**
 * Planner Intelligence — external data + quality scoring + health assessment.
 * Weather forecast via Open-Meteo (free, no API key).
 */

import { SEA_ACTIVITIES, HARD_ACTIVITIES } from '@/lib/planner-constants';
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import { buildDayParts, type DayPart, type HourlySeries } from '@/lib/weather/day-parts';

// ── Weather Forecast ─────────────────────────────────────────────────────────

const WMO_DESCRIPTIONS: Record<number, string> = {
  0: 'Ясно', 1: 'Малооблачно', 2: 'Переменная облачность', 3: 'Пасмурно',
  45: 'Туман', 48: 'Изморозь', 51: 'Морось', 53: 'Морось', 55: 'Сильная морось',
  61: 'Дождь', 63: 'Умеренный дождь', 65: 'Сильный дождь',
  71: 'Снег', 73: 'Умеренный снег', 75: 'Сильный снег', 77: 'Снежная крупа',
  80: 'Ливень', 81: 'Сильный ливень', 82: 'Очень сильный ливень',
  85: 'Снегопад', 86: 'Сильный снегопад',
  95: 'Гроза', 96: 'Гроза с градом', 99: 'Сильная гроза с градом',
};

function wmoDescription(code: number): string {
  return WMO_DESCRIPTIONS[code] ?? (code <= 3 ? 'Ясно' : code <= 48 ? 'Облачно' : code <= 67 ? 'Дождь' : code <= 77 ? 'Снег' : 'Осадки');
}

/**
 * День прогноза, в котором отсутствие значения — `null`, а не ноль.
 *
 * До 25.09 единственный загрузчик заполнял пропуски нулями: нет кода погоды —
 * код 0, «Ясно»; нет ветра — 0 км/ч, штиль. А при отказе Open-Meteo отдавал
 * пустой список без единой строки в логе. Rescue читал это как «угроз нет»,
 * бронь на четвёртый день не проверялась вовсе (прогноз запрашивался на три),
 * и ни то ни другое снаружи не было видно (§4.0).
 */
export interface ForecastDay {
  date: string;
  tempMax: number | null;
  tempMin: number | null;
  precipMm: number | null;
  windKmh: number | null;
  weatherCode: number | null;
  description: string | null;
  /**
   * Ночь/утро/день/вечер по почасовому прогнозу (#2249). Пустой или нет —
   * почасовых данных не пришло, остаётся суточная строка.
   */
  parts?: DayPart[];
}

/** Три исхода загрузки сведены к двум: прогноз есть — или «не смог», с причиной. */
export type ForecastResult =
  | {
      ok: true;
      days: ForecastDay[];
      /**
       * Высота точки прогноза, м — Open-Meteo берёт её из своей 90-метровой
       * модели рельефа ПО КООРДИНАТЕ, а не средней по клетке. null — не отдана.
       * Заведено 07.10 (#2249): прогноз вершины без высоты читался прогнозом
       * всего похода («Авачинский: −15…−9, снег» при нуле у подножия).
       */
      elevationM?: number | null;
      /**
       * Источник сейчас не отвечает (429, сеть), и это ПОСЛЕДНИЙ удачный
       * прогноз — с моментом, когда он получен. Нет поля — прогноз свежий.
       */
      staleSince?: string;
      /**
       * Когда прогноз получен от источника. Кэш отдаёт его с этим же моментом,
       * поэтому страница погоды пишет «прогноз от …» по нему, а не по времени
       * сборки страницы: прогноз из кэша бывает старше на три часа.
       */
      fetchedAt?: string;
    }
  | { ok: false; reason: string };

const FORECAST_TTL = 3 * 60 * 60 * 1000;
/** Отказ кэшируется коротко: двадцать броней одной зоны — один таймаут, а не двадцать. */
const FORECAST_FAIL_TTL = 5 * 60 * 1000;
const forecastCache = new Map<string, { result: ForecastResult; expiresAt: number }>();
/**
 * Последний УДАЧНЫЙ прогноз по точке — на случай 429 и отказа сети (#2249:
 * 08.10 Налычево и Мутновский не загрузились и после повторов). Отдаётся с
 * отметкой staleSince, а не за свежий; старше суток — не отдаётся вовсе.
 */
const lastGoodForecast = new Map<string, { result: Extract<ForecastResult, { ok: true }>; at: number }>();
const LAST_GOOD_MAX_AGE = 24 * 60 * 60 * 1000;
/**
 * Потолок кэша. get_weather на публичном MCP принимает любую точку Земли, и
 * без потолка каждый новый квадрат сотых градуса оставался в памяти процесса
 * на три часа (проверка MCP 29.09). Зон планера и мест края — сотни, запас
 * десятикратный.
 */
const FORECAST_CACHE_MAX = 5000;

function rememberForecast(key: string, result: ForecastResult, ttl: number): void {
  if (forecastCache.size >= FORECAST_CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of forecastCache) if (v.expiresAt <= now) forecastCache.delete(k);
    // Всё свежее — выбрасываются самые старые записи (Map хранит порядок вставки).
    for (const k of forecastCache.keys()) {
      if (forecastCache.size < FORECAST_CACHE_MAX) break;
      forecastCache.delete(k);
    }
  }
  forecastCache.set(key, { result, expiresAt: Date.now() + ttl });
}

/** Для сторожа: сколько точек сейчас в кэше. */
export function forecastCacheSize(): number {
  return forecastCache.size;
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Осадки — из GFS, температура и ветер — из сводной модели Open-Meteo (#2249).
 *
 * Повод — посты канала о погоде 06.10 и 08.10, которые пришлось править
 * руками. Замер 08.10 (weather-model-skill, прогон 3): 89 суток факта станции
 * Петропавловск-Камчатский (сводки SYNOP 32583) против прогноза на сутки
 * вперёд. «Сухо / осадки» при пороге 1 мм верно у GFS в 0,888 случаев, у
 * best_match — в 0,798: сводная модель пропускала четверть дождливых дней, и
 * треть её «осадков» были ложными. При 2 мм — 0,921 против 0,843. Горизонт
 * у GFS тот же, 16 суток.
 *
 * Замер мерил ТОЛЬКО осадки, поэтому температура и ветер остаются из
 * best_match: у GFS в той же точке ветер почти вдвое сильнее (проба 722:
 * суточный максимум 63–78 против 39–45 км/ч), и менять его без своего замера
 * не на чем основать. Код погоды об осадках — из GFS вместе с миллиметрами:
 * «снег» или «ливень» в описании должны сходиться с суммой, а не спорить с
 * ней. Небо сухого дня (ясно, пасмурно, туман) — из best_match, как до замера
 * (см. mergeWeatherCode). Нет значения у GFS — берётся сводная модель, по
 * одному дню или часу, а не весь прогноз.
 */
export const PRECIP_MODEL = 'gfs_seamless';
export const BASE_MODEL = 'best_match';
const PRECIP_DAILY = ['precipitation_sum', 'weather_code'];
const BASE_DAILY = ['temperature_2m_max', 'temperature_2m_min', 'wind_speed_10m_max'];
const PRECIP_HOURLY = ['precipitation', 'snowfall'];
const BASE_HOURLY = ['temperature_2m', 'wind_speed_10m'];

type ForecastBlock = Record<string, unknown[] | undefined>;

/** Ряд поля модели; в ответе одной модели суффикса нет — поле как есть. */
function modelSeries(block: ForecastBlock, field: string, model: string): unknown[] | undefined {
  return block[`${field}_${model}`] ?? block[field];
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function preferFinite(primary: unknown[] | undefined, fallback: unknown[] | undefined): unknown[] | undefined {
  if (!primary) return fallback;
  if (!fallback) return primary;
  return primary.map((v, i) => (isNum(v) ? v : fallback[i]));
}

/** С 51 (морось) код погоды говорит об осадках; ниже — небо и туман. */
const PRECIP_CODE_MIN = 51;

/**
 * Код погоды по дням: об осадках — голосом GFS, о небе — голосом best_match.
 *
 * Код несёт два разных сообщения. «Дождь», «снег», «ливень» — то же, что
 * миллиметры, и берутся у GFS, иначе описание спорило бы с суммой. «Ясно»,
 * «пасмурно», «туман» — облачность и видимость, которых замер не мерил. Когда
 * код брался у GFS целиком (#2286), на проде (prod-check 96, зона Авачинского)
 * сухие дни стали «туманом» и «ясно» там, где best_match говорил «пасмурно».
 * Туман — не подпись: его читает Rescue как вопрос видимости.
 *
 * Сухой у GFS день, который best_match называл дождливым, получает код GFS:
 * «дождь» при нуле миллиметров был бы той же ссорой описания с суммой.
 */
function mergeWeatherCode(gfs: unknown[] | undefined, base: unknown[] | undefined): unknown[] | undefined {
  if (!gfs) return base;
  return gfs.map((g, i) => {
    const b = base?.[i];
    if (!isNum(g)) return b;
    if (g >= PRECIP_CODE_MIN) return g;
    return isNum(b) && b < PRECIP_CODE_MIN ? b : g;
  });
}

/**
 * Ответ с двумя моделями — к виду одной: поля осадков из PRECIP_MODEL (пусто —
 * из BASE_MODEL; код погоды — по mergeWeatherCode), остальные — из
 * BASE_MODEL. Чистая, под тестом на настоящем ответе Open-Meteo (проба 722).
 */
export function mergeForecastModels(
  block: ForecastBlock | undefined,
  precipFields: readonly string[],
  baseFields: readonly string[],
): ForecastBlock | undefined {
  if (!block) return block;
  const out: ForecastBlock = { time: block.time };
  for (const f of baseFields) out[f] = modelSeries(block, f, BASE_MODEL);
  for (const f of precipFields) {
    const primary = modelSeries(block, f, PRECIP_MODEL);
    const fallback = modelSeries(block, f, BASE_MODEL);
    out[f] = f === 'weather_code' ? mergeWeatherCode(primary, fallback) : preferFinite(primary, fallback);
  }
  return out;
}

/**
 * Суточный прогноз Open-Meteo по точке, до 16 дней, в поясе Камчатки.
 * Отказ сети, не-2xx и ответ не той формы — `{ ok: false }` и строка в логе.
 */
export async function fetchForecastDays(lat: number, lng: number, days: number): Promise<ForecastResult> {
  const horizon = Math.max(1, Math.min(16, Math.round(days)));
  const cacheKey = `${lat.toFixed(2)},${lng.toFixed(2)},${horizon}`;
  const hit = forecastCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.result;

  let result: ForecastResult;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,weather_code&hourly=temperature_2m,precipitation,snowfall,wind_speed_10m&forecast_days=${horizon}&timezone=Asia/Kamchatka&models=${BASE_MODEL},${PRECIP_MODEL}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      result = { ok: false, reason: `Open-Meteo HTTP ${res.status}` };
    } else {
      const json = await res.json() as {
        elevation?: unknown;
        hourly?: ForecastBlock;
        daily?: ForecastBlock;
      };
      const d = mergeForecastModels(json.daily, PRECIP_DAILY, BASE_DAILY);
      const hourly = mergeForecastModels(json.hourly, PRECIP_HOURLY, BASE_HOURLY) as HourlySeries | undefined;
      if (!d || !Array.isArray(d.time)) {
        result = { ok: false, reason: 'Open-Meteo: ответ без daily.time' };
      } else {
        result = {
          ok: true,
          fetchedAt: new Date().toISOString(),
          elevationM: finite(json.elevation) === null ? null : Math.round(finite(json.elevation) as number),
          days: d.time.map((date, i) => {
            const code = finite(d.weather_code?.[i]);
            return {
              date: String(date),
              tempMax: finite(d.temperature_2m_max?.[i]),
              tempMin: finite(d.temperature_2m_min?.[i]),
              precipMm: finite(d.precipitation_sum?.[i]),
              windKmh: finite(d.wind_speed_10m_max?.[i]),
              weatherCode: code,
              description: code === null ? null : wmoDescription(code),
              parts: buildDayParts(hourly, String(date)),
            };
          }),
        };
      }
    }
  } catch (err) {
    result = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  if (!result.ok) {
    logSwallowedFailure('weather', `прогноз Open-Meteo (${lat.toFixed(2)}, ${lng.toFixed(2)})`, new Error(result.reason));
    // Последний удачный прогноз — с отметкой, а не за свежий. Отказ при этом
    // уже записан в лог строкой выше: «отдали старое» не прячет «не ответил».
    const good = lastGoodForecast.get(cacheKey);
    if (good && Date.now() - good.at < LAST_GOOD_MAX_AGE) {
      const stale: ForecastResult = { ...good.result, staleSince: new Date(good.at).toISOString() };
      rememberForecast(cacheKey, stale, FORECAST_FAIL_TTL);
      return stale;
    }
  } else {
    lastGoodForecast.delete(cacheKey); // свежая запись — в конец порядка вытеснения
    lastGoodForecast.set(cacheKey, { result, at: Date.now() });
    if (lastGoodForecast.size > FORECAST_CACHE_MAX) {
      const oldest = lastGoodForecast.keys().next().value;
      if (oldest !== undefined) lastGoodForecast.delete(oldest);
    }
  }
  rememberForecast(cacheKey, result, result.ok ? FORECAST_TTL : FORECAST_FAIL_TTL);
  return result;
}

const DAY_MS = 86_400_000;

/** Сегодняшняя дата на Камчатке: от неё Open-Meteo считает дни (timezone=Asia/Kamchatka). */
function kamchatkaToday(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kamchatka', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function addDaysIso(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Даты дней поездки и горизонт прогноза, который до них достаёт.
 *
 * До 25.09 планер брал прогноз от СЕГОДНЯ и раскладывал его по дням плана
 * по номеру: при приезде через неделю первый день получал сегодняшнюю погоду,
 * и она же уходила в промпт планера. День плана ищется по ДАТЕ; поездка
 * целиком за 16 днями прогноза (или в прошлом) — `null`: погоды у такого
 * плана нет, и это честнее чужого дня.
 */
export function tripForecastWindow(
  arrivalDate: string,
  dayCount: number,
  now: Date = new Date(),
): { dates: string[]; horizon: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}/.test(arrivalDate) || dayCount < 1) return null;
  const arrival = arrivalDate.slice(0, 10);
  const offset = Math.round(
    (Date.parse(`${arrival}T00:00:00Z`) - Date.parse(`${kamchatkaToday(now)}T00:00:00Z`)) / DAY_MS,
  );
  if (!Number.isFinite(offset)) return null;
  const lastOffset = offset + dayCount - 1;
  if (lastOffset < 0 || offset > 15) return null;
  return {
    dates: Array.from({ length: dayCount }, (_, i) => addDaysIso(arrival, i)),
    horizon: Math.min(16, lastOffset + 1),
  };
}

// ── Quality Score ────────────────────────────────────────────────────────────

/**
 * Compute 0-100 quality score from tour/operator signals.
 *
 * Weights: tourRating(35) + operatorRating(20) + reviewVolume(15)
 *          + verified(10) + recentPositive(10) + verifiedReviews(10)
 */
export function computeQualityScore(params: {
  tourRating: number | null;
  tourReviewCount: number;
  operatorRating: number;
  operatorReviewCount: number;
  operatorVerified: boolean;
  recentPositivePercent: number;
  verifiedReviewCount: number;
}): number {
  const tr = params.tourRating ?? params.operatorRating;
  const totalReviews = params.tourReviewCount + params.operatorReviewCount;

  let score = 0;
  score += (tr / 5) * 35;                                          // 0-35
  score += (params.operatorRating / 5) * 20;                       // 0-20
  score += Math.min(15, Math.log2(totalReviews + 1) * 3);          // 0-15
  score += params.operatorVerified ? 10 : 0;                       // 0-10
  score += (params.recentPositivePercent / 100) * 10;              // 0-10
  score += Math.min(10, params.verifiedReviewCount * 2);           // 0-10

  return Math.round(Math.min(100, Math.max(0, score)));
}

// ── Health Compatibility ─────────────────────────────────────────────────────

export interface HealthAssessment {
  compatible: boolean;
  warnings: string[];
  alternatives: string[];
}

const SEASICKNESS_KEYWORDS = ['укачива', 'морская болезнь', 'морск', 'seasick', 'тошнит на воде', 'кинетоз'];
const INJURY_KEYWORDS = ['колен', 'ног', 'спин', 'травм', 'перелом', 'knee', 'back', 'injur'];
const HEART_KEYWORDS = ['сердц', 'давлен', 'heart', 'гипертон', 'аритм', 'кардио'];

function matchesKeywords(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

/**
 * Assess if an activity is compatible with tourist's health conditions.
 * Returns warnings (not blocks) — the tourist decides.
 */
export function assessHealthCompatibility(
  activityType: string,
  seasickness: boolean,
  healthNotes: string | undefined,
  mobilityLevel: 'full' | 'limited' | 'wheelchair' | undefined,
): HealthAssessment {
  const warnings: string[] = [];
  const alternatives: string[] = [];
  let compatible = true;

  // Seasickness check
  const hasSeasickness = seasickness || (healthNotes ? matchesKeywords(healthNotes, SEASICKNESS_KEYWORDS) : false);
  if (hasSeasickness && SEA_ACTIVITIES.has(activityType)) {
    warnings.push(`${activityType}: морская болезнь — морские экскурсии, рыбалка с катера и прибрежные туры могут вызвать дискомфорт. Рассмотрите террасные источники или треккинг.`);
    alternatives.push('hot_spring', 'trekking');
  }

  // Injury/mobility keywords
  if (healthNotes && matchesKeywords(healthNotes, INJURY_KEYWORDS) && HARD_ACTIVITIES.has(activityType)) {
    warnings.push(`${activityType}: при травмах опорно-двигательного аппарата сложные маршруты (5-10 часов ходьбы, набор высоты 800+ м) могут быть некомфортны. Рассмотрите облегчённые варианты.`);
    alternatives.push('hot_spring', 'helicopter');
  }

  // Heart/pressure keywords
  if (healthNotes && matchesKeywords(healthNotes, HEART_KEYWORDS) && HARD_ACTIVITIES.has(activityType)) {
    warnings.push(`${activityType}: при сердечно-сосудистых заболеваниях набор высоты может быть опасен. Обязательно проконсультируйтесь с врачом перед поездкой.`);
    compatible = false;
    alternatives.push('hot_spring', 'helicopter');
  }

  // Mobility level
  if (mobilityLevel === 'wheelchair') {
    if (activityType !== 'hot_spring' && activityType !== 'helicopter') {
      warnings.push(`${activityType}: безбарьерная инфраструктура на Камчатке крайне ограничена. Доступные варианты: термальные источники Паратунки (есть пандусы), обзорные вертолётные экскурсии.`);
      compatible = false;
      alternatives.push('hot_spring', 'helicopter');
    }
  } else if (mobilityLevel === 'limited') {
    if (HARD_ACTIVITIES.has(activityType)) {
      warnings.push(`${activityType}: ограниченная подвижность — выбраны облегчённые маршруты, исключены многочасовые переходы и крутые подъёмы.`);
      alternatives.push('hot_spring', 'bears');
    }
  }

  return { compatible, warnings, alternatives };
}
