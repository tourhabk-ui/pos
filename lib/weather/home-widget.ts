/**
 * Виджет погоды на главной (слово владельца 23.10: «между кнопками своя
 * поездка и радар … длинный стильный виджет с погодой, при нажатии переход на
 * страницу погоды»).
 *
 * Источник — тот же, что у /weather, Кузьмича и экрана безопасности:
 * `loadPlaceWeather` → `fetchForecastDays` (кэш на три часа общий, своего
 * запроса к Open-Meteo виджет не делает), место — Петропавловск, как у
 * страницы /weather. День или ночь (знак луны или солнца) — правило
 * lib/weather/scene, то же, что у героя страницы: виджет и страница, куда он
 * ведёт, не расходятся. Фона сцены у плитки с вечера 23.10 нет: она стекло,
 * как соседние плитки главной.
 *
 * ── Исходы (§4.0) ──────────────────────────────────────────────────────────
 *  - ok      — прогноз есть; чего в нём нет (температуры, ветра), того нет и в
 *              виджете — без нулей и «примерно»;
 *  - failed  — прогноз не получили: виджет говорит «не загрузился» и всё
 *              равно ведёт на страницу погоды, цифр не рисует;
 *  - pending — прогноз не успел за бюджет главной (холодный кэш после
 *              выката): главная не ждёт Open-Meteo до 12 с, виджет дотягивает
 *              данные сам из GET /api/weather/home, держа ту же высоту.
 *
 * Предупреждения Росгидромета — только когда они есть. «Предупреждений нет»
 * виджет не говорит вовсе: источник мог молчать дольше своего порога, и тогда
 * пустота — неизвестность, а не факт (то же правило, что у страницы).
 */
import {
  kamchatkaDate, loadMeteoWarnings, loadPlaceWeather, type PlaceWeather, type WarningsRead,
} from '@/lib/weather/weather-page';
import { DEFAULT_WEATHER_SLUG, weatherPlaceBySlug } from '@/lib/weather/places';
import { currentHour, weatherScene } from '@/lib/weather/scene';
import { fmtTemp, kamchatkaTime, skyWords, windLine } from '@/lib/weather/weather-format';
import type { HomeWeather, HomeWeatherWarning } from '@/lib/weather/home-widget-types';

export type { HomeWeather, HomeWeatherDay, HomeWeatherWarning } from '@/lib/weather/home-widget-types';

/** Сколько главная ждёт прогноз, прежде чем отдать виджету «дотяни сам». */
export const HOME_WEATHER_BUDGET_MS = 1500;
export const HOME_WEATHER_DAYS = 3;

function weekday(date: string): string {
  const w = new Date(`${date}T12:00:00Z`).toLocaleDateString('ru-RU', { weekday: 'short', timeZone: 'UTC' });
  return w.charAt(0).toUpperCase() + w.slice(1);
}

/** «+4» / null: пропуск не становится «?» в крупной цифре виджета. */
const fmtOrNull = (v: number | null): string | null => (v === null ? null : fmtTemp(v));

function warningOf(read: WarningsRead): HomeWeatherWarning | null {
  if (read.kind === 'failed' || read.items.length === 0) return null;
  const top = read.items.reduce((a, b) => (b.severity > a.severity ? b : a));
  return { count: read.items.length, title: top.title, severity: top.severity };
}

/** Чистое правило: прогноз места и предупреждения → то, что рисует виджет. */
export function homeWeatherFrom(w: PlaceWeather, warnings: WarningsRead, now: Date = new Date()): HomeWeather {
  if (w.kind !== 'ok' || w.days.length === 0) return { kind: 'failed' };
  const today = kamchatkaDate(now);
  const day = w.days.find((d) => d.date === today) ?? w.days[0];
  const hour = currentHour(w);
  const scene = weatherScene(w, today);
  const windKmh = w.now?.windKmh ?? hour?.windKmh ?? null;
  return {
    kind: 'ok',
    place: w.place.name,
    temp: fmtOrNull(w.now?.temp ?? hour?.temp ?? null),
    code: w.now?.weatherCode ?? hour?.weatherCode ?? day?.weatherCode ?? null,
    isDay: scene.period === 'day',
    sky: (w.now?.description ?? hour?.description ?? (day ? skyWords(day) : null))?.toLowerCase() ?? null,
    wind: windKmh === null ? null : windLine(windKmh),
    days: w.days
      .filter((d) => d.date > today)
      .slice(0, HOME_WEATHER_DAYS)
      .map((d) => ({ date: d.date, weekday: weekday(d.date), code: d.weatherCode ?? null, max: fmtOrNull(d.tempMax), min: fmtOrNull(d.tempMin) })),
    warning: warningOf(warnings),
    staleFrom: kamchatkaTime(w.staleSince),
  };
}

export async function loadHomeWeather(now: Date = new Date()): Promise<HomeWeather> {
  const place = weatherPlaceBySlug(DEFAULT_WEATHER_SLUG);
  if (!place) return { kind: 'failed' };
  try {
    const [w, warnings] = await Promise.all([loadPlaceWeather(place), loadMeteoWarnings(now)]);
    return homeWeatherFrom(w, warnings, now);
  } catch (err) {
    console.error('[home-weather] прогноз для главной не собран:', err instanceof Error ? err.message.slice(0, 200) : String(err));
    return { kind: 'failed' };
  }
}

/**
 * Для главной: ждать прогноз не дольше бюджета. Не успел — «pending», а
 * начатая загрузка доходит в фоне и греет кэш для запроса виджета.
 */
export async function loadHomeWeatherWithin(
  budgetMs: number = HOME_WEATHER_BUDGET_MS,
  now: Date = new Date(),
  load: (now: Date) => Promise<HomeWeather> = loadHomeWeather,
): Promise<HomeWeather> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<HomeWeather>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'pending' }), budgetMs);
  });
  try {
    return await Promise.race([load(now), pending]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
