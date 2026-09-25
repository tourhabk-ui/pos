/**
 * Planner Intelligence — external data + quality scoring + health assessment.
 * Weather forecast via Open-Meteo (free, no API key).
 */

import { SEA_ACTIVITIES, HARD_ACTIVITIES } from '@/lib/planner-constants';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

// ── Weather Forecast ─────────────────────────────────────────────────────────

export interface DayForecast {
  date: string;
  tempMax: number;
  tempMin: number;
  precipMm: number;
  windKmh: number;
  weatherCode: number;
  description: string;
}

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
}

/** Три исхода загрузки сведены к двум: прогноз есть — или «не смог», с причиной. */
export type ForecastResult =
  | { ok: true; days: ForecastDay[] }
  | { ok: false; reason: string };

const FORECAST_TTL = 3 * 60 * 60 * 1000;
/** Отказ кэшируется коротко: двадцать броней одной зоны — один таймаут, а не двадцать. */
const FORECAST_FAIL_TTL = 5 * 60 * 1000;
const forecastCache = new Map<string, { result: ForecastResult; expiresAt: number }>();

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
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
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,weather_code&forecast_days=${horizon}&timezone=Asia/Kamchatka`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      result = { ok: false, reason: `Open-Meteo HTTP ${res.status}` };
    } else {
      const json = await res.json() as {
        daily?: {
          time?: unknown[];
          temperature_2m_max?: unknown[];
          temperature_2m_min?: unknown[];
          precipitation_sum?: unknown[];
          wind_speed_10m_max?: unknown[];
          weather_code?: unknown[];
        };
      };
      const d = json.daily;
      if (!d || !Array.isArray(d.time)) {
        result = { ok: false, reason: 'Open-Meteo: ответ без daily.time' };
      } else {
        result = {
          ok: true,
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
  }
  forecastCache.set(cacheKey, {
    result,
    expiresAt: Date.now() + (result.ok ? FORECAST_TTL : FORECAST_FAIL_TTL),
  });
  return result;
}

/**
 * Прежний загрузчик для планера: пустой список при отказе, пропуски — нулями.
 *
 * Оставлен ради потребителей, которые берут день ПО НОМЕРУ (`forecast[day - 1]`
 * в lib/planner/engine.ts и compose.ts): выбросить неполный день значило бы
 * сдвинуть им все последующие. Нули здесь — известная ложь, а не решение;
 * новый код берёт `fetchForecastDays`. Отказ теперь хотя бы пишется в лог.
 */
export async function fetchWeatherForecast(
  lat: number, lng: number, days: number
): Promise<DayForecast[]> {
  const r = await fetchForecastDays(lat, lng, days);
  if (!r.ok) return [];
  return r.days.map((d) => ({
    date: d.date,
    tempMax: d.tempMax ?? 0,
    tempMin: d.tempMin ?? 0,
    precipMm: d.precipMm ?? 0,
    windKmh: d.windKmh ?? 0,
    weatherCode: d.weatherCode ?? 0,
    description: d.description ?? wmoDescription(0),
  }));
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
