/**
 * Данные страницы погоды (`/weather`): прогноз по местам и действующие
 * предупреждения Росгидромета.
 *
 * Источник прогноза один с Кузьмичом, сводкой и планером —
 * `fetchForecastDays` (осадки из GFS, температура и ветер из сводной модели,
 * #2249). Своего запроса к Open-Meteo здесь нет, и кэш тот же: девять мест
 * страницы — девять записей кэша на три часа, а не девять запросов на заход.
 *
 * ── Третий исход (§4.0) ────────────────────────────────────────────────────
 *
 * У места три исхода: прогноз есть; места нет (в каталоге не нашлось);
 * прогноз не получили (Open-Meteo не ответил, база не ответила). У
 * предупреждений — тоже три: прочитаны при живом источнике; прочитаны, но
 * источник молчит дольше своего порога (тогда «предупреждений нет» — не
 * факт, а неизвестность); не прочитаны вовсе.
 */
import { pool } from '@/lib/db-pool';
import { fetchForecastDays, type ForecastDay } from '@/lib/planner/intelligence';
import { resolvePlaceCoords } from '@/lib/kuzmich/weather-tool';
import { METEOALERT_PREFIX } from '@/lib/services/safety/meteoalert';
import { SAFETY_SOURCE_EXPECTATIONS } from '@/lib/services/safety/source-health';
import { WEATHER_PLACES, weatherPlaceBySlug, type WeatherPlace } from '@/lib/weather/places';

/** Дней прогноза у каждого места: семь — неделя вперёд, и кэш один на все блоки страницы. */
export const WEATHER_PAGE_DAYS = 7;

export type PlaceWeather =
  | {
      kind: 'ok';
      place: WeatherPlace;
      lat: number;
      lng: number;
      elevationM: number | null;
      days: ForecastDay[];
      /** Когда прогноз получен от источника; null — источник момент не дал. */
      fetchedAt: string | null;
      /** Источник не отвечает, это последний удачный прогноз — от этого момента. */
      staleSince: string | null;
    }
  | { kind: 'missing'; place: WeatherPlace }
  | { kind: 'failed'; place: WeatherPlace; reason: string };

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200);

export async function loadPlaceWeather(place: WeatherPlace): Promise<PlaceWeather> {
  let point: { lat: number; lng: number };
  if ('catalog' in place.source) {
    try {
      const found = await resolvePlaceCoords(place.source.catalog);
      if (!found) return { kind: 'missing', place };
      point = { lat: found.lat, lng: found.lng };
    } catch (err) {
      console.error('[weather-page] координаты места не прочитаны:', place.slug, errText(err));
      return { kind: 'failed', place, reason: 'координаты места не прочитаны' };
    }
  } else {
    if (!place.source.point) return { kind: 'missing', place };
    point = place.source.point;
  }

  // Отказ Open-Meteo fetchForecastDays пишет в лог сам — здесь он только назван.
  const f = await fetchForecastDays(point.lat, point.lng, WEATHER_PAGE_DAYS);
  if (!f.ok) return { kind: 'failed', place, reason: f.reason };
  if (f.days.length === 0) return { kind: 'failed', place, reason: 'пустой прогноз' };
  return {
    kind: 'ok',
    place,
    lat: point.lat,
    lng: point.lng,
    elevationM: f.elevationM ?? null,
    days: f.days,
    fetchedAt: f.fetchedAt ?? null,
    staleSince: f.staleSince ?? null,
  };
}

export interface MeteoWarningItem {
  /** «Ветер — жёлтый уровень (юг края)» — заголовок без «Росгидромет:». */
  title: string;
  text: string;
  /** 1 — жёлтый, 2 — оранжевый, 3 — красный (шкала meteoalert). */
  severity: 1 | 2 | 3;
  until: string | null;
}

export type WarningsRead =
  | { kind: 'ok'; items: MeteoWarningItem[]; checkedAt: string }
  | { kind: 'silent'; items: MeteoWarningItem[]; checkedAt: string | null }
  | { kind: 'failed' };

/**
 * Сколько часов тишины источник предупреждений терпит, пока его ответ ещё
 * «сейчас»: порог берётся из реестра здоровья источников, а не задаётся
 * здесь второй раз. Нет записи — судить о свежести нечем (null).
 */
const METEOALERT_SILENCE_HOURS: number | null =
  SAFETY_SOURCE_EXPECTATIONS.find((s) => s.key === 'meteoalert')?.maxSilenceHours ?? null;

const toIso = (v: Date | string | null): string | null => {
  if (v === null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const toSeverity = (v: number | null): 1 | 2 | 3 => (v === 3 ? 3 : v === 2 ? 2 : 1);

export async function loadMeteoWarnings(now: Date = new Date()): Promise<WarningsRead> {
  try {
    const [alerts, health] = await Promise.all([
      pool.query<{ title: string; description: string | null; severity: number | null; expires_at: Date | string | null }>(
        `SELECT title, description, severity, expires_at
           FROM external_alerts
          WHERE external_id LIKE $1
            AND expires_at > NOW()
          ORDER BY severity DESC NULLS LAST, created_at DESC
          LIMIT 10`,
        [`${METEOALERT_PREFIX}/%`],
      ),
      pool.query<{ last_nonempty_at: Date | string | null }>(
        `SELECT last_nonempty_at FROM safety_source_health WHERE source_key = $1`,
        ['meteoalert'],
      ),
    ]);
    const items: MeteoWarningItem[] = alerts.rows.map((r) => {
      const title = r.title.replace(/^Росгидромет:\s*/, '');
      return {
        title: title.charAt(0).toUpperCase() + title.slice(1),
        text: (r.description ?? '').trim(),
        severity: toSeverity(r.severity),
        until: toIso(r.expires_at),
      };
    });
    const checkedAt = toIso(health.rows[0]?.last_nonempty_at ?? null);
    const fresh = checkedAt !== null && METEOALERT_SILENCE_HOURS !== null
      && now.getTime() - Date.parse(checkedAt) <= METEOALERT_SILENCE_HOURS * 3_600_000;
    return fresh && checkedAt ? { kind: 'ok', items, checkedAt } : { kind: 'silent', items, checkedAt };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error('[weather-page] предупреждения Росгидромета не прочитаны:', typeof code === 'string' ? code : '', errText(err));
    return { kind: 'failed' };
  }
}

/** Сегодняшняя дата на Камчатке — от неё Open-Meteo считает дни. */
export function kamchatkaDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kamchatka', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export interface WeatherPageData {
  selected: PlaceWeather;
  /** Все места в порядке списка, выбранное тоже. */
  all: PlaceWeather[];
  warnings: WarningsRead;
  /** Сегодня по Камчатке, YYYY-MM-DD. */
  today: string;
  generatedAt: string;
}

/** Страница одного места. null — такого места в списке нет (404). */
export async function loadWeatherPage(slug: string, now: Date = new Date()): Promise<WeatherPageData | null> {
  const place = weatherPlaceBySlug(slug);
  if (!place) return null;
  const [all, warnings] = await Promise.all([
    Promise.all(WEATHER_PLACES.map(loadPlaceWeather)),
    loadMeteoWarnings(now),
  ]);
  const selected = all.find((w) => w.place.slug === place.slug) as PlaceWeather;
  return { selected, all, warnings, today: kamchatkaDate(now), generatedAt: now.toISOString() };
}
