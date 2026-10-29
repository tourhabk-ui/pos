/**
 * Planner Intelligence — external data + quality scoring + health assessment.
 * Weather forecast via Open-Meteo (free, no API key).
 */

import { SEA_ACTIVITIES, HARD_ACTIVITIES } from '@/lib/planner-constants';
import { logSwallowedFailure } from '@/lib/observability/swallowed';
import { loadLastGood, saveLastGood } from '@/lib/weather/last-good-store';
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
  /** Вероятность осадков за сутки, % (Open-Meteo). */
  precipProbMax?: number | null;
  windGustKmh?: number | null;
  /** Направление преобладающего ветра, градусы (0 — север, 90 — восток). */
  windDirDeg?: number | null;
  /** Восход/закат местного времени, ISO без пояса («2026-10-20T07:59»). */
  sunrise?: string | null;
  sunset?: string | null;
  uvIndexMax?: number | null;
}

/** Один час прогноза для ленты и плиток страницы погоды. */
export interface ForecastHour {
  time: string;
  temp: number | null;
  apparent: number | null;
  humidity: number | null;
  precipMm: number | null;
  precipProb: number | null;
  windKmh: number | null;
  windGustKmh: number | null;
  windDirDeg: number | null;
  weatherCode: number | null;
  description: string | null;
  cloudCover: number | null;
  visibilityM: number | null;
  /** Давление, приведённое к уровню моря (pressure_msl), гПа — как в приложениях. */
  pressureHpa: number | null;
  uvIndex: number | null;
}

/** Текущий момент по блоку current Open-Meteo; null-поля — источник не дал. */
export interface ForecastNow {
  time: string | null;
  temp: number | null;
  apparent: number | null;
  humidity: number | null;
  weatherCode: number | null;
  description: string | null;
  windKmh: number | null;
  windGustKmh: number | null;
  windDirDeg: number | null;
  /** Давление, приведённое к уровню моря (pressure_msl), гПа. Не surface_pressure: на горной точке оно ниже на сотни мм. */
  pressureHpa: number | null;
  isDay: boolean | null;
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
      hours?: ForecastHour[];
      now?: ForecastNow | null;
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
/** Дальше 16 суток Open-Meteo не считает — длиннее горизонта не бывает. */
const MAX_HORIZON = 16;
/**
 * Загрузки, которые уже в пути, — по ключу кэша (склейка одновременных
 * запросов). Главная ждёт прогноз 1,5 с (`loadHomeWeatherWithin`) и отпускает
 * страницу, а начатая загрузка доходит в фоне; следом виджет зовёт
 * `/api/weather/home` о той же точке и том же горизонте. На холодном кэше после
 * выката это был второй запрос к Open-Meteo, пока первый ещё в пути (до 12 с).
 * Запись снимается на исходе загрузки (`.finally`), поэтому дольше одной
 * загрузки она не живёт и потолка не требует.
 */
const forecastInflight = new Map<string, Promise<ForecastResult>>();

type OkForecast = Extract<ForecastResult, { ok: true }>;

/**
 * Короткий горизонт из длинного прогноза той же точки: первые `horizon` дней и
 * часы только этих дат. Остальное (now, elevationM, fetchedAt, staleSince) — от
 * исходной записи: срез не делает прогноз ни свежее, ни старее. Длинное из
 * короткого не собирается: дни сверх полученных были бы выдуманы.
 */
function sliceForecast(result: OkForecast, horizon: number): OkForecast {
  if (result.days.length <= horizon) return result;
  const days = result.days.slice(0, horizon);
  const dates = new Set(days.map((d) => d.date));
  return {
    ...result,
    days,
    ...(result.hours ? { hours: result.hours.filter((h) => dates.has(h.time.slice(0, 10))) } : {}),
  };
}

/**
 * Свежий прогноз той же точки на горизонт ДЛИННЕЕ запрошенного — срезом.
 * Сводка берёт 2 дня, get_weather — 3, /weather и главная — 7: без этого одна
 * точка за три часа уходила к источнику до трёх раз. Запасной прогноз (с
 * staleSince) сюда не берётся: у короткого ключа может быть свой запас свежее.
 * Срез в кэш не кладётся — он живёт ровно столько, сколько исходная запись.
 */
function freshFromLonger(point: string, horizon: number, now: number): OkForecast | null {
  let best: { result: OkForecast; expiresAt: number } | null = null;
  for (let h = horizon + 1; h <= MAX_HORIZON; h++) {
    const e = forecastCache.get(`${point},${h}`);
    if (!e || e.expiresAt <= now || !e.result.ok || e.result.staleSince) continue;
    // Источник отдал дней меньше запрошенного — короткого горизонта в нём нет.
    if (e.result.days.length < horizon) continue;
    if (!best || e.expiresAt > best.expiresAt) best = { result: e.result, expiresAt: e.expiresAt };
  }
  return best ? sliceForecast(best.result, horizon) : null;
}

/**
 * Последний удачный прогноз точки на этот горизонт или длиннее — самый свежий,
 * не старше суток, срезом. Его момент (`at`) — момент ИСХОДНОЙ записи: от него
 * staleSince и предел суток.
 */
function lastGoodFor(point: string, horizon: number, now: number): { result: OkForecast; at: number } | null {
  let best: { result: OkForecast; at: number } | null = null;
  for (let h = horizon; h <= MAX_HORIZON; h++) {
    const g = lastGoodForecast.get(`${point},${h}`);
    if (!g || now - g.at >= LAST_GOOD_MAX_AGE) continue;
    if (!best || g.at > best.at) best = g;
  }
  return best ? { result: sliceForecast(best.result, horizon), at: best.at } : null;
}

/** Запас с отметкой держится в кэше не дольше отказа и не дальше суток от своей удачи. */
function staleTtl(at: number): number {
  return Math.min(FORECAST_FAIL_TTL, at + LAST_GOOD_MAX_AGE - Date.now());
}

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
const BASE_DAILY = ['temperature_2m_max', 'temperature_2m_min', 'wind_speed_10m_max', 'precipitation_probability_max', 'wind_gusts_10m_max', 'wind_direction_10m_dominant', 'sunrise', 'sunset', 'uv_index_max'];
const PRECIP_HOURLY = ['precipitation', 'snowfall'];
const BASE_HOURLY = ['temperature_2m', 'wind_speed_10m', 'apparent_temperature', 'relative_humidity_2m', 'wind_direction_10m', 'wind_gusts_10m', 'weather_code', 'cloud_cover', 'visibility', 'pressure_msl', 'precipitation_probability', 'uv_index'];

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
 * Причина отказа Open-Meteo словами — с тем, КАКОЙ лимит кончился (#2289).
 *
 * На 429 сервис пишет в теле `{"error":true,"reason":"Daily API request limit
 * exceeded…"}` — минутный, часовой или суточный. До 10.10 тело выбрасывалось,
 * и пост канала четвёртый день писал «Налычево — 429», а гадать приходилось,
 * что именно кончилось: разные лимиты лечатся разным (минутный — разнести
 * запросы, суточный — ключ или меньше вызовов; адрес исходящий общий, его
 * делят Кузьмич, Rescue, планер и /weather). Догадка «лимит по координатам»
 * из отчёта того же дня кодом не подтверждалась — теперь проверяется логом.
 *
 * Текст чужого сервиса наружу не пересказывается: узнаётся только род
 * лимита, всё прочее — голый код, как раньше.
 */
export function openMeteoFailureReason(status: number, body: string): string {
  const base = `Open-Meteo HTTP ${status}`;
  let reason = '';
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    if (typeof parsed?.reason === 'string') reason = parsed.reason;
  } catch {
    // Тело не JSON (прокси, обрыв) — рода лимита не знаем, остаётся код.
    return base;
  }
  if (/minutely/i.test(reason)) return `${base} (исчерпан минутный лимит запросов)`;
  if (/hourly/i.test(reason)) return `${base} (исчерпан часовой лимит запросов)`;
  if (/daily/i.test(reason)) return `${base} (исчерпан суточный лимит запросов)`;
  return base;
}


/** Почасовой ряд из сводного блока; время — местное ISO без пояса. */
export function parseForecastHours(hourly: ForecastBlock | undefined): ForecastHour[] {
  if (!hourly || !Array.isArray(hourly.time)) return [];
  return hourly.time.flatMap((t, i) => {
    if (typeof t !== 'string') return [];
    const code = finite(hourly.weather_code?.[i]);
    return [{
      time: t,
      temp: finite(hourly.temperature_2m?.[i]),
      apparent: finite(hourly.apparent_temperature?.[i]),
      humidity: finite(hourly.relative_humidity_2m?.[i]),
      precipMm: finite(hourly.precipitation?.[i]),
      precipProb: finite(hourly.precipitation_probability?.[i]),
      windKmh: finite(hourly.wind_speed_10m?.[i]),
      windGustKmh: finite(hourly.wind_gusts_10m?.[i]),
      windDirDeg: finite(hourly.wind_direction_10m?.[i]),
      weatherCode: code,
      description: code === null ? null : wmoDescription(code),
      cloudCover: finite(hourly.cloud_cover?.[i]),
      visibilityM: finite(hourly.visibility?.[i]),
      pressureHpa: finite(hourly.pressure_msl?.[i]),
      uvIndex: finite(hourly.uv_index?.[i]),
    }];
  });
}

/**
 * Блок current Open-Meteo. Запрос идёт с двумя моделями, и поле может прийти
 * как без суффикса, так и с суффиксом модели (`temperature_2m_best_match`) —
 * читаются обе формы, правилом суток: температура, ветер и прочее — из
 * BASE_MODEL, код погоды об осадках — из PRECIP_MODEL (mergeWeatherCode).
 * Заведено 29.10 (#2289): «сейчас» стали читать /api/weather,
 * /api/public/now и погода тура оператора, и форма ответа не должна молча
 * обнулять им текущий момент.
 */
export function parseForecastNow(current: Record<string, unknown> | undefined): ForecastNow | null {
  if (!current || typeof current !== 'object') return null;
  const base = (field: string): unknown => current[`${field}_${BASE_MODEL}`] ?? current[field];
  const gfsCode = current[`weather_code_${PRECIP_MODEL}`];
  const code = finite(gfsCode === undefined
    ? base('weather_code')
    : mergeWeatherCode([gfsCode], [base('weather_code')])?.[0]);
  const isDay = base('is_day');
  return {
    time: typeof current.time === 'string' ? current.time : null,
    temp: finite(base('temperature_2m')),
    apparent: finite(base('apparent_temperature')),
    humidity: finite(base('relative_humidity_2m')),
    weatherCode: code,
    description: code === null ? null : wmoDescription(code),
    windKmh: finite(base('wind_speed_10m')),
    windGustKmh: finite(base('wind_gusts_10m')),
    windDirDeg: finite(base('wind_direction_10m')),
    pressureHpa: finite(base('pressure_msl')),
    isDay: typeof isDay === 'number' ? isDay === 1 : null,
  };
}

/**
 * Текущий момент прогноза для тех, кому нужно «сейчас»: блок current, а чего
 * в нём нет — час ленты, совпадающий с current.time (нет current.time —
 * первый час не раньше `now` по часам Камчатки). Пропуск остаётся null.
 * Час — ещё и источник облачности, видимости и УФ: в блоке current их нет.
 */
export function forecastCurrent(
  f: Pick<Extract<ForecastResult, { ok: true }>, 'hours' | 'now'>,
  now: Date = new Date(),
): { now: ForecastNow | null; hour: ForecastHour | null; hourIndex: number } {
  const hours = f.hours ?? [];
  const nowBlock = f.now ?? null;
  let idx = -1;
  if (nowBlock?.time) {
    const prefix = nowBlock.time.slice(0, 13);
    idx = hours.findIndex((h) => h.time.startsWith(prefix));
  }
  if (idx < 0 && hours.length > 0) {
    const local = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Kamchatka', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).format(now).replace(' ', 'T').slice(0, 13);
    idx = hours.findIndex((h) => h.time.slice(0, 13) >= local);
  }
  return { now: nowBlock, hour: idx >= 0 ? hours[idx] : null, hourIndex: idx };
}

/**
 * Причина отказа прогноза для людей. Сырая строка («The operation was aborted
 * due to timeout», «fetch failed») уходит в лог, на страницу — по-русски.
 */
export function forecastReasonRu(raw: string): string {
  if (/abort|timeout|timed out|ETIMEDOUT/i.test(raw)) return 'источник прогноза не ответил вовремя';
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|network/i.test(raw)) return 'нет связи с источником прогноза';
  if (/[\u0400-\u04FF]/.test(raw)) return raw;
  const http = /HTTP (\d{3})/.exec(raw);
  return http ? `источник прогноза ответил ошибкой (HTTP ${http[1]})` : 'источник прогноза ответил ошибкой';
}

/**
 * Суточный прогноз Open-Meteo по точке, до 16 дней, в поясе Камчатки.
 * Отказ сети, не-2xx и ответ не той формы — `{ ok: false }` и строка в логе.
 *
 * Порядок: свежий прогноз этого горизонта → свежий прогноз той же точки на
 * горизонт длиннее, срезом → свой отказ или запас из кэша → загрузка, уже
 * идущая по этому ключу → новая загрузка. К источнику идёт только последняя.
 */
export async function fetchForecastDays(lat: number, lng: number, days: number): Promise<ForecastResult> {
  const horizon = Math.max(1, Math.min(MAX_HORIZON, Math.round(days)));
  const point = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const cacheKey = `${point},${horizon}`;
  const now = Date.now();
  const hit = forecastCache.get(cacheKey);
  const live = hit && hit.expiresAt > now ? hit.result : null;
  if (live && live.ok && !live.staleSince) return live;
  // Свежий длинный прогноз той же точки лучше своего отказа или запаса.
  const longer = freshFromLonger(point, horizon, now);
  if (longer) return longer;
  if (live) return live;

  const pending = forecastInflight.get(cacheKey);
  if (pending) return pending;
  const load = loadForecast(lat, lng, horizon, point, cacheKey).finally(() => {
    if (forecastInflight.get(cacheKey) === load) forecastInflight.delete(cacheKey);
  });
  forecastInflight.set(cacheKey, load);
  return load;
}

async function loadForecast(lat: number, lng: number, horizon: number, point: string, cacheKey: string): Promise<ForecastResult> {
  let result: ForecastResult;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,weather_code,precipitation_probability_max,wind_gusts_10m_max,wind_direction_10m_dominant,sunrise,sunset,uv_index_max&hourly=temperature_2m,precipitation,snowfall,wind_speed_10m,apparent_temperature,relative_humidity_2m,wind_direction_10m,wind_gusts_10m,weather_code,cloud_cover,visibility,pressure_msl,precipitation_probability,uv_index&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,is_day&forecast_days=${horizon}&timezone=Asia/Kamchatka&models=${BASE_MODEL},${PRECIP_MODEL}`;
    // 12 с (было 8): 21.10 с прода Open-Meteo отвечал дольше 8 с, и вся погода
    // падала в «Прогноз не получили» (страница, «Обстановка», Кузьмич).
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      result = { ok: false, reason: openMeteoFailureReason(res.status, body.slice(0, 2000)) };
    } else {
      const json = await res.json() as {
        elevation?: unknown;
        hourly?: ForecastBlock;
        daily?: ForecastBlock;
        current?: Record<string, unknown>;
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
            const str = (v: unknown) => (typeof v === 'string' ? v : null);
            return {
              date: String(date),
              tempMax: finite(d.temperature_2m_max?.[i]),
              tempMin: finite(d.temperature_2m_min?.[i]),
              precipMm: finite(d.precipitation_sum?.[i]),
              windKmh: finite(d.wind_speed_10m_max?.[i]),
              weatherCode: code,
              description: code === null ? null : wmoDescription(code),
              parts: buildDayParts(hourly, String(date)),
              precipProbMax: finite(d.precipitation_probability_max?.[i]),
              windGustKmh: finite(d.wind_gusts_10m_max?.[i]),
              windDirDeg: finite(d.wind_direction_10m_dominant?.[i]),
              sunrise: str(d.sunrise?.[i]),
              sunset: str(d.sunset?.[i]),
              uvIndexMax: finite(d.uv_index_max?.[i]),
            };
          }),
          hours: parseForecastHours(hourly as unknown as ForecastBlock | undefined),
          now: parseForecastNow(json.current),
        };
      }
    }
  } catch (err) {
    result = { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  if (!result.ok) {
    logSwallowedFailure('weather', `прогноз Open-Meteo (${lat.toFixed(2)}, ${lng.toFixed(2)})`, new Error(result.reason));
    // Людям — по-русски; сырая причина уже в логе строкой выше.
    result = { ok: false, reason: forecastReasonRu(result.reason) };
    // Последний удачный прогноз — с отметкой, а не за свежий. Отказ при этом
    // уже записан в лог строкой выше: «отдали старое» не прячет «не ответил».
    // Годится и запас длиннее запрошенного — срезом, с его же моментом.
    const good = lastGoodFor(point, horizon, Date.now());
    if (good) {
      const stale: ForecastResult = { ...good.result, staleSince: new Date(good.at).toISOString() };
      rememberForecast(cacheKey, stale, staleTtl(good.at));
      return stale;
    }
    // Памяти нет (перезапуск) — запас из базы, тоже с отметкой. Из базы — только
    // по точному ключу.
    const stored = await loadLastGood<Extract<ForecastResult, { ok: true }>>(cacheKey);
    if (stored && stored.result && Array.isArray(stored.result.days)) {
      const stale: ForecastResult = { ...stored.result, staleSince: new Date(stored.at).toISOString() };
      lastGoodForecast.set(cacheKey, { result: stored.result, at: stored.at });
      rememberForecast(cacheKey, stale, staleTtl(stored.at));
      return stale;
    }
  } else {
    void saveLastGood(cacheKey, result, new Date());
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
