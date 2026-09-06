/**
 * lib/services/seismic-feed.ts — единый источник сейсмособытий Камчатки.
 * Приоритет: КБГС РАН из external_alerts (ingest ~20 мин). Fallback: USGS live
 * (кэш 5 мин в памяти). Общий слой для /api/safety/seismic и Главной v8 —
 * чтобы «сейсмо» на витрине показывала РЕАЛЬНЫЕ толчки, а не бутафорию.
 */

import { pool } from '@/lib/db-pool';
import { lastIngestAt } from '@/lib/safety/ingest-run';

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
        AND created_at > NOW() - INTERVAL '48 hours'
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
