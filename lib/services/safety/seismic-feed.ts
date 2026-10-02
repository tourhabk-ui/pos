/**
 * lib/services/seismic-feed.ts — единый источник сейсмособытий Камчатки.
 * Приоритет: КБГС РАН из external_alerts (ingest ~20 мин). Fallback: USGS live
 * (кэш 5 мин в памяти). Общий слой для /api/safety/seismic и Главной v8 —
 * чтобы «сейсмо» на витрине показывала РЕАЛЬНЫЕ толчки, а не бутафорию.
 */

import { pool } from '@/lib/db-pool';
import { lastIngestAt } from '@/lib/safety/ingest-run';
import { distanceKm } from '@/lib/services/safety/seismic-zones';

export interface SeismicEvent {
  id: string;
  magnitude: number;
  place: string;
  time: number;       // epoch ms
  depth: number | null;
  lat: number | null;
  lng: number | null;
}
export interface SeismicFeed {
  events: SeismicEvent[];
  source: 'kbgsras' | 'usgs' | 'none';
  updatedAt: string;
  /**
   * Когда мы В ПОСЛЕДНИЙ РАЗ спрашивали источник.
   *
   * Отдельно от времени события намеренно. На экране стояло «41 ч назад» — это
   * возраст толчка, и по нему нельзя понять, проверяли ли мы что-нибудь за эти
   * сорок один час. Человек в поле читает такую строку как «связи нет» или
   * «приложение зависло», хотя новых толчков просто не было.
   *
   * Для ленты КБГС это время последнего ingest-прогона (крон, ~20 мин), для
   * USGS — время живого запроса.
   */
  checkedAt: string | null;
  /** Ответ пришёл из кэша, а не от источника. */
  fromCache: boolean;
}

let usgsCache: { data: { events: SeismicEvent[]; source: 'usgs' }; ts: number } | null = null;
const USGS_TTL = 5 * 60 * 1000;

function parseTitleKbgsras(title: string): { magnitude: number; place: string } {
  const magMatch = title.match(/ML?\s*(\d+(?:[.,]\d+)?)/i);
  const magnitude = magMatch ? parseFloat(magMatch[1].replace(',', '.')) : 0;
  const place = title
    .replace(/^Землетрясение\s*/i, '')
    .replace(/ML?\s*\d+(?:[.,]\d+)?\s*[—–-]\s*/i, '')
    .trim() || title;
  return { magnitude, place: place.slice(0, 120) };
}

function parseDepth(text: string | null): number | null {
  if (!text) return null;
  const m = text.match(/(\d+)\s*км\s*глуб|глуб[а-я]*\s*(\d+)\s*км/i);
  if (!m) return null;
  return parseInt(m[1] ?? m[2]);
}

async function fetchFromKbgsras(): Promise<{ events: SeismicEvent[]; source: 'kbgsras'; checkedAt: number | null } | null> {
  try {
    const { rows } = await pool.query<{
      id: string; title: string; description: string | null; created_at: Date;
      magnitude: string | null; lat: string | null; lng: string | null;
    }>(`
      SELECT id::text, title, description, created_at, magnitude, lat, lng
      FROM external_alerts
      WHERE alert_type = 'earthquake'
        -- created_at без пояса, в UTC; NOW() — в поясе сессии (+03 на проде).
        AND created_at > (NOW() AT TIME ZONE 'UTC') - INTERVAL '48 hours'
      ORDER BY created_at DESC
      LIMIT 15
    `);
    if (rows.length === 0) return null;
    const events: SeismicEvent[] = rows
      .map((r) => {
        const parsed = parseTitleKbgsras(r.title);
        const magnitude = r.magnitude != null ? parseFloat(r.magnitude) : parsed.magnitude;
        return {
          id: r.id,
          magnitude,
          place: parsed.place,
          time: new Date(r.created_at).getTime(),
          depth: parseDepth(r.description),
          lat: r.lat != null ? parseFloat(r.lat) : null,
          lng: r.lng != null ? parseFloat(r.lng) : null,
        };
      })
      .filter((e) => e.magnitude > 0);
    // Время последнего ПРОГОНА приёма, а не последней записи.
    //
    // Здесь стоял `MAX(created_at)` по external_alerts, и комментарий обещал
    // «время прогона ingest» — но это время СОБЫТИЯ. Замер 05.09
    // (prod-check run 15): приём отработал минуту назад, свежайшая запись
    // землетрясения — 41-часовой давности. Экран сказал бы «проверено
    // позавчера» при живом приёме, и человек прочитал бы поломку там, где её
    // нет. Возраст события уже виден в строке самого события.
    const runAt = await lastIngestAt();
    const checkedAt = runAt ? new Date(runAt).getTime() : null;
    return events.length > 0 ? { events, source: 'kbgsras', checkedAt } : null;
  } catch {
    return null;
  }
}

async function fetchFromUsgs(fresh = false): Promise<{ events: SeismicEvent[]; source: 'usgs'; checkedAt: number; fromCache: boolean }> {
  // `fresh` пропускает кэш, но не ограничитель: до источника доходит только
  // то, что разрешил allowFresh (см. lib/safety/refresh-throttle).
  const useCache = usgsCache && Date.now() - usgsCache.ts < USGS_TTL && !fresh;
  if (useCache && usgsCache) return { ...usgsCache.data, checkedAt: usgsCache.ts, fromCache: true };
  const url =
    'https://earthquake.usgs.gov/fdsnws/event/1/query' +
    '?format=geojson&minlatitude=50&maxlatitude=63&minlongitude=155&maxlongitude=165' +
    '&minmagnitude=2.5&limit=10&orderby=time';
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`USGS HTTP ${res.status}`);
  const raw = (await res.json()) as {
    features: { id: string; properties: { mag: number; place: string; time: number }; geometry: { coordinates: [number, number, number] } }[];
  };
  const events: SeismicEvent[] = (raw.features ?? []).map((f) => ({
    id: f.id,
    magnitude: f.properties.mag,
    place: f.properties.place,
    time: f.properties.time,
    depth: f.geometry.coordinates[2],
    lng: f.geometry.coordinates[0] ?? null,
    lat: f.geometry.coordinates[1] ?? null,
  }));
  const result = { events, source: 'usgs' as const };
  const ts = Date.now();
  usgsCache = { data: result, ts };
  return { ...result, checkedAt: ts, fromCache: false };
}

/** Единая точка получения сейсмоленты. Никогда не бросает — на сбое отдаёт пусто. */
export async function getSeismicFeed(opts: { fresh?: boolean } = {}): Promise<SeismicFeed> {
  const local = await fetchFromKbgsras();
  if (local) {
    return {
      events: local.events,
      source: local.source,
      updatedAt: new Date().toISOString(),
      checkedAt: local.checkedAt !== null ? new Date(local.checkedAt).toISOString() : null,
      fromCache: false,
    };
  }
  try {
    const usgs = await fetchFromUsgs(opts.fresh === true);
    return {
      events: usgs.events,
      source: usgs.source,
      updatedAt: new Date().toISOString(),
      checkedAt: new Date(usgs.checkedAt).toISOString(),
      fromCache: usgs.fromCache,
    };
  } catch {
    // Источник не ответил. `checkedAt: null` — «не знаем, когда данные», а не
    // «данные сейчас»: пустая лента со свежим временем врёт дважды.
    return { events: [], source: 'none', updatedAt: new Date().toISOString(), checkedAt: null, fromCache: false };
  }
}


// ── Толчки на карту за окно (02.10) ──────────────────────────────────────

/**
 * Владелец 02.10, скрины eqkam: за вечер шесть толчков у Авачинского залива
 * (M6.2 и повторные), а на /map их не было ни одного. Лента выше отдаёт
 * 15 последних за 48 ч — для строки на экране безопасности, не для карты.
 * Карте нужны ВСЕ толчки с координатами за окно, одной точкой на толчок.
 */
export const QUAKE_MAP_MAX_HOURS = 72;
/** Предохранитель от рояля на пол: рой афтершоков — десятки, не тысячи. */
const QUAKE_MAP_CAP = 500;
/** Один толчок из разных источников: время ближе 2 мин и место ближе 50 км. */
export const SAME_QUAKE_SECONDS = 120;
export const SAME_QUAKE_KM = 50;

export interface MapQuake {
  id: string;
  magnitude: number;
  time: number;
  depth: number | null;
  lat: number;
  lng: number;
}

/**
 * Склейка дублей: eqkam, КБГС, EMSD и USGS пишут один толчок отдельными
 * строками с немного разными временем, местом и магнитудой. Остаётся
 * запись с наибольшей магнитудой — на карте страшнее правда, чем занижение.
 * Чистая функция: вход отсортирован как угодно, выход — по времени, новые
 * первыми.
 */
export function mergeSameQuakes(events: MapQuake[]): MapQuake[] {
  const byMag = events.slice().sort((a, b) => b.magnitude - a.magnitude);
  const kept: MapQuake[] = [];
  for (const e of byMag) {
    const twin = kept.some(k =>
      Math.abs(k.time - e.time) <= SAME_QUAKE_SECONDS * 1000
      && distanceKm(k.lat, k.lng, e.lat, e.lng) <= SAME_QUAKE_KM);
    if (!twin) kept.push(e);
  }
  return kept.sort((a, b) => b.time - a.time);
}

/**
 * Все толчки с координатами за последние `hours` часов. Исход «не смог»
 * не глушится: упавший запрос бросает, вызывающий отвечает 502, а не
 * пустой картой (§4.0) — «толчков не было» и «не прочитали» разные вещи.
 */
export async function getQuakesForMap(hours: number): Promise<MapQuake[]> {
  const h = Math.min(Math.max(Math.round(hours), 1), QUAKE_MAP_MAX_HOURS);
  const { rows } = await pool.query<{
    id: string; title: string; created_at: Date; magnitude: string | null;
    lat: string | null; lng: string | null; description: string | null;
  }>(`
    SELECT id::text, title, created_at, magnitude, lat, lng, description
      FROM external_alerts
     WHERE alert_type = 'earthquake'
       -- created_at без пояса, в UTC; NOW() — в поясе сессии (+03 на проде).
       AND created_at > (NOW() AT TIME ZONE 'UTC') - INTERVAL '1 hour' * $1
       AND lat IS NOT NULL AND lng IS NOT NULL
     ORDER BY created_at DESC
     LIMIT ${QUAKE_MAP_CAP}
  `, [h]);
  const events: MapQuake[] = [];
  for (const r of rows) {
    const magnitude = r.magnitude != null ? parseFloat(r.magnitude) : parseTitleKbgsras(r.title).magnitude;
    const lat = parseFloat(String(r.lat));
    const lng = parseFloat(String(r.lng));
    if (!(magnitude > 0) || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    events.push({
      id: r.id, magnitude, lat, lng,
      time: new Date(r.created_at).getTime(),
      depth: parseDepth(r.description),
    });
  }
  return mergeSameQuakes(events);
}
