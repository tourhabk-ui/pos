/**
 * Погода тура для порогов оператора (`/api/hub/operator/weather`).
 */
import { fetchForecastDays, forecastCurrent } from '@/lib/planner/intelligence';

/** null — прогноз этого не дал; порог по такому полю не проверяется, а называется (§4.0). */
export interface TourWeather {
  wind_speed_kmh: number | null;   // ветер сейчас, км/ч
  precipitation_mm: number | null; // сумма осадков ближайших 3 часов
  visibility_m: number | null;     // оценка по коду погоды и облачности
  temperature_c: number | null;
  weather_code: number | null;
  fetched_at: string | null;
  /** Источник не ответил, это последний удачный прогноз — от этого момента. */
  stale_since: string | null;
}

/**
 * Погода тура — общий прогноз платформы (`fetchForecastDays`, #2289, 29.10).
 *
 * До этого роут ходил в Open-Meteo сам, со своим часовым кэшем, и нёс два
 * дефекта: ветер умножался на 3,6, хотя Open-Meteo без `wind_speed_unit`
 * отдаёт км/ч (17 км/ч становились 61 — тот же дефект, что снят с /api/weather
 * 24.09), а пропуски заполнялись выдумкой (облачность 50 %, код погоды 0 —
 * «ясно», осадки 0). Теперь: ветер — км/ч как есть, осадки ближайших трёх
 * часов — из GFS (замер #2249), пропуск — null и «не проверено».
 */
export async function fetchTourWeather(lat: number, lng: number): Promise<TourWeather | { failed: string }> {
  const f = await fetchForecastDays(lat, lng, 1);
  if (!f.ok) return { failed: f.reason };
  const { now, hour, hourIndex } = forecastCurrent(f);
  const hours = f.hours ?? [];
  const next3 = hourIndex >= 0 ? hours.slice(hourIndex, hourIndex + 3) : [];
  const precip = next3.length === 3 && next3.every((h) => h.precipMm !== null)
    ? Math.round(next3.reduce((acc, h) => acc + (h.precipMm as number), 0) * 10) / 10
    : null;
  const code = now?.weatherCode ?? hour?.weatherCode ?? null;
  const cloud = hour?.cloudCover ?? null;
  const wind = now?.windKmh ?? hour?.windKmh ?? null;
  const temp = now?.temp ?? hour?.temp ?? null;
  return {
    wind_speed_kmh: wind === null ? null : Math.round(wind),
    precipitation_mm: precip,
    visibility_m: code === null || cloud === null ? null : estimateVisibilityM(code, cloud),
    temperature_c: temp === null ? null : Math.round(temp),
    weather_code: code,
    fetched_at: f.fetchedAt ?? null,
    stale_since: f.staleSince ?? null,
  };
}

/** Rough visibility estimate from WMO weather codes + cloud cover */
export function estimateVisibilityM(wmoCode: number, cloudCover: number): number {
  if ([45, 48].includes(wmoCode)) return 200;      // fog
  if (wmoCode >= 95) return 1000;                  // thunderstorm
  if ([71, 73, 75, 77, 85, 86].includes(wmoCode)) return 2000;  // snow
  if ([65, 67].includes(wmoCode)) return 3000;     // heavy rain
  if ([61, 63].includes(wmoCode)) return 5000;     // rain
  if ([51, 53, 55, 80, 81, 82].includes(wmoCode)) return 7000;  // drizzle/showers
  if (cloudCover > 90) return 8000;
  if (cloudCover > 70) return 12000;
  return 20000;
}
