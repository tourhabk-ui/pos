/**
 * Погода МЕСТА или ТОЧКИ — одно правило для Кузьмича и MCP (25.09).
 *
 * До этого дня инструмент `get_weather`, который видят Кузьмич и внешние
 * агенты через MCP, не принимал аргументов вовсе: схема пустая, описание
 * «текущая погода в Петропавловске-Камчатском». Английское описание в
 * реестре MCP при этом обещало «place or coordinates» — обещание без
 * исполнения (правило 10.09). Человек на перевале получал город: между
 * Петропавловском и Мутновским тридцать километров по прямой и километр по
 * высоте, и решение «идти сегодня» принимается по погоде там, а не тут.
 *
 * Источник прогноза на платформе один — Open-Meteo через
 * `lib/planner/intelligence` (тот же, что у планера и SDK-инструмента);
 * второго здесь не заводится.
 *
 * Исходы названы словами (§4.0): место не найдено, координаты не разобраны,
 * прогноз не пришёл — это разные ответы, и ни один не выдаётся за погоду.
 */
import { pool } from '@/lib/db-pool';
import { fetchForecastDays, type ForecastDay } from '@/lib/planner/intelligence';
import { insideKrai } from '@/lib/geo/krai-envelope';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

export const DEFAULT_WEATHER_PLACE = { name: 'Петропавловск-Камчатский', lat: 53.02, lng: 158.65 } as const;
export const WEATHER_DAYS_DEFAULT = 3;
export const WEATHER_DAYS_MAX = 7;

/**
 * Координаты живой точки по её имени. Ровно тот предикат живости, что у
 * переписей: скрытые и слитые записи не считаются местом.
 */
export async function resolvePlaceCoords(
  name: string,
): Promise<{ name: string; lat: number; lng: number } | null> {
  const { rows } = await pool.query<{ name: string; lat: number; lng: number }>(
    `SELECT name, lat::float AS lat, lng::float AS lng
       FROM places
      WHERE name ILIKE $1
        AND lat IS NOT NULL AND lng IS NOT NULL
        AND is_visible = true AND merged_into_id IS NULL
      ORDER BY length(name) ASC
      LIMIT 1`,
    [`%${name}%`],
  );
  return rows[0] ?? null;
}

/** Число из строки агента: «53.26» и «53,26» — одно и то же. null — не число. */
export function parseCoord(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw.trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export type WeatherTarget =
  | { kind: 'point'; name: string; lat: number; lng: number; outsideKrai: boolean }
  | { kind: 'place'; query: string }
  | { kind: 'default' }
  | { kind: 'invalid'; message: string };

/**
 * Что спрошено. Координаты главнее имени: их прислали, чтобы не гадать по
 * справочнику. Одна координата без второй — не точка, а ошибка агента, и
 * молча подставлять город вместо неё нельзя.
 */
export function weatherTarget(args: { place?: string; lat?: string; lng?: string }): WeatherTarget {
  const hasLat = args.lat !== undefined;
  const hasLng = args.lng !== undefined;
  if (hasLat || hasLng) {
    if (!hasLat || !hasLng) {
      return { kind: 'invalid', message: 'Нужны обе координаты — lat и lng. По одной точку не найти, погоду не выдаю.' };
    }
    const lat = parseCoord(args.lat);
    const lng = parseCoord(args.lng);
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return { kind: 'invalid', message: `Координаты «${args.lat}, ${args.lng}» не разобраны: нужны градусы, широта от -90 до 90, долгота от -180 до 180.` };
    }
    return {
      kind: 'point',
      name: `точка ${lat.toFixed(4)}, ${lng.toFixed(4)}`,
      lat, lng,
      outsideKrai: insideKrai(lat, lng) === false,
    };
  }
  if (args.place) return { kind: 'place', query: args.place };
  return { kind: 'default' };
}

export function parseDays(raw: string | undefined): number {
  const n = raw === undefined ? NaN : Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 1) return WEATHER_DAYS_DEFAULT;
  return Math.min(WEATHER_DAYS_MAX, n);
}

function fmtTemp(v: number | null): string {
  if (v === null) return '?';
  const r = Math.round(v);
  return r > 0 ? `+${r}` : String(r);
}

/**
 * Строка дня. Пропуск в прогнозе — «нет данных», а не ноль: ноль ветра
 * читается штилем, ноль осадков — сухим днём.
 */
export function forecastLine(d: ForecastDay): string {
  const [, m, day] = d.date.split('-');
  const temp = d.tempMin === null && d.tempMax === null ? 'температура — нет данных' : `${fmtTemp(d.tempMin)}…${fmtTemp(d.tempMax)}°C`;
  const precip = d.precipMm === null ? 'осадки — нет данных' : `осадки ${d.precipMm} мм`;
  const wind = d.windKmh === null ? 'ветер — нет данных' : `ветер до ${Math.round(d.windKmh)} км/ч`;
  const sky = d.description ?? 'небо — нет данных';
  return `${day}.${m}: ${temp}, ${precip}, ${wind}, ${sky}`;
}

/** Ответ инструмента `get_weather` — текстом для модели. */
export async function weatherForKuzmich(args: { place?: string; lat?: string; lng?: string; days?: string }): Promise<string> {
  const target = weatherTarget(args);
  if (target.kind === 'invalid') return target.message;
  const days = parseDays(args.days);

  let point: { name: string; lat: number; lng: number };
  let note = '';
  try {
    if (target.kind === 'point') {
      point = target;
      if (target.outsideKrai) note = ' Точка вне Камчатского края — прогноз дан, но это не наш район.';
    } else if (target.kind === 'place') {
      const found = await resolvePlaceCoords(target.query);
      if (!found) {
        return `Места «${target.query}» нет в справочнике платформы — прогноз именно для него дать не могу. `
          + 'Можно спросить по координатам (lat, lng). Погоду другого места не выдавай за его погоду.';
      }
      point = found;
    } else {
      point = DEFAULT_WEATHER_PLACE;
      note = ' Место не названо — это Петропавловск-Камчатский, в горах погода другая.';
    }
    const forecast = await fetchForecastDays(point.lat, point.lng, days);
    if (!forecast.ok || forecast.days.length === 0) {
      const why = forecast.ok ? 'пустой прогноз' : forecast.reason;
      console.error('[weather-tool] прогноз не получен:', point.name, why);
      return `ПОГОДА НЕДОСТУПНА для «${point.name}»: прогноз не пришёл (${why}). Не называй погоду по памяти — скажи, что проверить не смог.`;
    }
    const head = `Прогноз Open-Meteo для «${point.name}» (${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}), дней: ${forecast.days.length}.${note}`;
    return [head, ...forecast.days.map(forecastLine)].join('\n');
  } catch (err) {
    logSwallowedFailure('kuzmich', 'прогноз погоды по месту', err);
    return 'ПОГОДА НЕДОСТУПНА: свериться с прогнозом не удалось — не называй погоду по памяти.';
  }
}
