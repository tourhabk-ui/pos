/**
 * Сцена погоды: небо и время суток из уже полученного прогноза.
 *
 * Одно правило на страницу погоды (/weather, components/weather/WeatherView)
 * и на виджет главной (lib/weather/home-widget): фон по небу и периоду
 * (.wx-scene в app/globals.css) обязан совпадать там и там, иначе на главной
 * «день, ясно», а на странице, куда ведёт виджет, — «ночь, пасмурно».
 * Новых данных сцена не просит.
 */
import type { ForecastHour } from '@/lib/planner/intelligence';
import type { PlaceWeather } from '@/lib/weather/weather-page';
import { hhmm } from '@/lib/weather/weather-format';

export type OkWeather = Extract<PlaceWeather, { kind: 'ok' }>;

/** Час прогноза, соответствующий «сейчас» источника; без него — первый час ленты. */
export function currentHour(w: Pick<OkWeather, 'hours' | 'now'>): ForecastHour | null {
  if (!w.hours || w.hours.length === 0) return null;
  const prefix = w.now?.time ? w.now.time.slice(0, 13) : null;
  if (prefix) {
    const hit = w.hours.find((h) => h.time.startsWith(prefix));
    if (hit) return hit;
  }
  return w.hours[0];
}

export type WeatherSky = 'clear' | 'cloud' | 'fog' | 'rain' | 'snow' | 'storm';

export function weatherSky(code: number | null): WeatherSky {
  if (code === null) return 'cloud';
  if (code === 0 || code === 1) return 'clear';
  if (code === 2 || code === 3) return 'cloud';
  if (code <= 48) return 'fog';
  if (code >= 95) return 'storm';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  return 'rain';
}

/**
 * День или ночь для сцены: сначала is_day источника; если его нет —
 * местное время прогноза между восходом и закатом этого дня; дальше —
 * час того же местного времени.
 */
export function weatherScene(
  w: Pick<OkWeather, 'days' | 'hours' | 'now'>,
  today: string,
): { name: string; period: 'day' | 'night'; sky: WeatherSky } {
  const day = w.days.find((d) => d.date === today) ?? w.days[0];
  const hour = currentHour(w);
  const code = w.now?.weatherCode ?? hour?.weatherCode ?? day?.weatherCode ?? null;
  const sky = weatherSky(code);
  let period: 'day' | 'night' | null = null;
  if (w.now?.isDay === true) period = 'day';
  else if (w.now?.isDay === false) period = 'night';
  if (period === null) {
    const nowHm = hhmm(w.now?.time ?? hour?.time);
    const sunrise = hhmm(day?.sunrise);
    const sunset = hhmm(day?.sunset);
    if (nowHm && sunrise && sunset) period = nowHm >= sunrise && nowHm < sunset ? 'day' : 'night';
    else if (nowHm) {
      const h = Number(nowHm.slice(0, 2));
      period = h >= 7 && h < 20 ? 'day' : 'night';
    }
  }
  const resolved = period ?? 'day';
  return { name: `${resolved}-${sky}`, period: resolved, sky };
}
