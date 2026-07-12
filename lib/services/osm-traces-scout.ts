/**
 * lib/services/osm-traces-scout.ts
 *
 * OSM Traces Scout — третий источник GPS-треков (после idilesom и OSM ways):
 * живые публичные GPS-записи туристов с openstreetmap.org/traces.
 *
 * Конвейер (ежесуточный cron через прод, openstreetmap.org доступен с Timeweb):
 *   1. RSS-ленты /traces/rss (+ тег Kamchatka) → трейсы с georss:point
 *   2. Фильтр bbox Камчатки (50–64° N, 155–167° E)
 *   3. Дедуп по dedupe_key `osmtrace:{id}`
 *   4. Скачивание GPX /trace/{id}/data (может быть gzip), ≥3 точек
 *   5. Привязка к месту — matchTrackToPlace (имя + близость к любой точке)
 *   6. INSERT в kamchatka_routes с is_visible=false — сырые пользовательские
 *      записи идут на ревью владельцу (/hub/admin/content/routes), в каталог
 *      не попадают до включения
 *   7. Telegram-дайджест новых треков админу
 */

import { gunzipSync } from 'zlib';
import { pool } from '@/lib/db-pool';
import { parseGpx } from '@/lib/services/visitkamchatka-gpx-importer';
import { matchTrackToPlace, type PlaceRef } from '@/lib/services/idilesom-importer';
import { fetchViaBrightData } from '@/lib/scraping/brightdata';

const HEADERS = {
  'User-Agent': 'VedarBot/1.0 (+https://vedarai.ru; туристическая платформа Камчатки)',
};

const RSS_FEEDS = [
  'https://www.openstreetmap.org/traces/rss',
  'https://www.openstreetmap.org/traces/tag/Kamchatka/rss',
  'https://www.openstreetmap.org/traces/tag/kamchatka/rss',
];

// Bbox Камчатского края с запасом
const BBOX = { latMin: 50, latMax: 64, lngMin: 155, lngMax: 167 };

export interface OsmTraceItem {
  id: string;
  title: string;
  link: string;
  lat: number;
  lng: number;
  pubDate: string | null;
}

export function isInKamchatka(lat: number, lng: number): boolean {
  return lat >= BBOX.latMin && lat <= BBOX.latMax && lng >= BBOX.lngMin && lng <= BBOX.lngMax;
}

/** Разбор RSS-ленты /traces/rss: id из ссылки, координата из georss:point. */
export function parseTracesRss(xml: string): OsmTraceItem[] {
  const items: OsmTraceItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const link = block.match(/<link>([^<]+)<\/link>/)?.[1]?.trim() ?? '';
    const id = link.match(/\/traces\/(\d+)/)?.[1] ?? null;
    const point = block.match(/<georss:point>([-\d.]+)\s+([-\d.]+)<\/georss:point>/);
    if (!id || !point) continue;
    const lat = parseFloat(point[1]);
    const lng = parseFloat(point[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const rawTitle = block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? '';
    items.push({
      id,
      title: rawTitle.replace(/<!\[CDATA\[|\]\]>/g, '').trim() || `OSM-трек ${id}`,
      link,
      lat,
      lng,
      pubDate: block.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1]?.trim() ?? null,
    });
  }
  return items;
}

// Первый прогон с прода (июль 2026): openstreetmap.org не отвечает с IP
// Timeweb — все ленты падают мгновенно. Фоллбэк — BrightData Web Unlocker,
// ровно как у idilesom-импортёра. Ошибку прямого запроса возвращаем для
// диагностики (feed_errors в результате).
type FetchedText = { text: string; via: 'direct' | 'brightdata' } | { text: null; error: string };

async function fetchText(url: string): Promise<FetchedText> {
  let directError: string;
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
    if (res.ok) return { text: await res.text(), via: 'direct' };
    directError = `HTTP ${res.status}`;
  } catch (e) {
    directError = e instanceof Error ? e.message : String(e);
  }
  const viaBd = await fetchViaBrightData(url);
  if (viaBd) return { text: viaBd, via: 'brightdata' };
  return { text: null, error: directError };
}

/** GPX трейса: /trace/{id}/data отдаёт файл как загружен — бывает gzip. */
async function fetchTraceGpx(id: string): Promise<string | null> {
  const url = `https://www.openstreetmap.org/trace/${id}/data`;
  try {
    const res = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        try {
          return gunzipSync(buf).toString('utf8');
        } catch {
          return null;
        }
      }
      return buf.toString('utf8');
    }
  } catch { /* фоллбэк ниже */ }
  // BrightData отдаёт тело текстом: обычный .gpx пройдёт, gzip-архив — нет
  // (побьётся при декодировании); такие трейсы честно лягут в no_gpx/too_short
  const viaBd = await fetchViaBrightData(url);
  return viaBd && viaBd.includes('<gpx') ? viaBd : null;
}

async function tgSend(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`${process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.substring(0, 4000),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    return ((await res.json()) as { ok: boolean }).ok === true;
  } catch {
    return false;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export interface OsmTracesScoutResult {
  feeds_ok: number;
  feed_errors: string[];
  seen: number;
  in_bbox: number;
  new_traces: number;
  written: number;
  linked: number;
  errors: number;
  duration_ms: number;
  items: Array<{
    id: string;
    title: string;
    status: 'written' | 'skipped_existing' | 'no_gpx' | 'too_short' | 'error';
    points?: number;
    place?: string;
  }>;
}

export async function scoutOsmTraces(): Promise<OsmTracesScoutResult> {
  const t0 = Date.now();
  const items: OsmTracesScoutResult['items'] = [];

  // 1-2. Ленты + bbox
  const byId = new Map<string, OsmTraceItem>();
  let feedsOk = 0;
  let seen = 0;
  const feedErrors: string[] = [];
  for (const feed of RSS_FEEDS) {
    const fetched = await fetchText(feed);
    if (fetched.text === null) {
      feedErrors.push(`${feed}: ${fetched.error.slice(0, 120)}`);
      continue;
    }
    feedsOk++;
    const parsed = parseTracesRss(fetched.text);
    seen += parsed.length;
    for (const it of parsed) {
      if (isInKamchatka(it.lat, it.lng)) byId.set(it.id, it);
    }
  }
  const candidates = [...byId.values()];

  // 3. Дедуп по уже записанным
  const keys = candidates.map(c => `osmtrace:${c.id}`);
  const { rows: doneRows } = keys.length
    ? await pool.query<{ dedupe_key: string }>(
        `SELECT dedupe_key FROM kamchatka_routes WHERE dedupe_key = ANY($1)`,
        [keys],
      )
    : { rows: [] as Array<{ dedupe_key: string }> };
  const done = new Set(doneRows.map(r => r.dedupe_key));

  const todo = candidates.filter(c => !done.has(`osmtrace:${c.id}`));
  for (const c of candidates) {
    if (done.has(`osmtrace:${c.id}`)) {
      items.push({ id: c.id, title: c.title, status: 'skipped_existing' });
    }
  }

  // Места — один раз для привязки
  const { rows: places } = todo.length
    ? await pool.query<PlaceRef>(
        `SELECT ark_id, name, lat::float AS lat, lng::float AS lng
         FROM places
         WHERE is_visible = true AND ark_id IS NOT NULL
           AND lat IS NOT NULL AND lng IS NOT NULL`,
      )
    : { rows: [] as PlaceRef[] };

  let written = 0;
  let linked = 0;
  let errors = 0;

  for (const trace of todo) {
    // 4. GPX
    const gpx = await fetchTraceGpx(trace.id);
    if (!gpx) {
      items.push({ id: trace.id, title: trace.title, status: 'no_gpx' });
      continue;
    }
    const coordinates = parseGpx(gpx);
    if (coordinates.length < 3) {
      items.push({ id: trace.id, title: trace.title, status: 'too_short', points: coordinates.length });
      continue;
    }

    // 5. Привязка к месту (название трейса часто «filename.gpx» — тогда без привязки)
    const match = matchTrackToPlace({ title: trace.title, coordinates }, places);

    try {
      // 6. Запись: сырой пользовательский трек — на ревью (is_visible=false)
      await pool.query(
        `INSERT INTO kamchatka_routes (
           category, title, description, lat, lng, geometry, metadata,
           source_url, source_name, is_visible, dedupe_key
         ) VALUES ('trekking', $1, $2, $3, $4, $5::jsonb, $6::jsonb,
                   $7, 'openstreetmap.org', false, $8)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        [
          trace.title,
          `Публичная GPS-запись с openstreetmap.org${trace.pubDate ? ` (${trace.pubDate})` : ''}. Требует проверки перед публикацией.`,
          coordinates[0][1],
          coordinates[0][0],
          JSON.stringify({ type: 'LineString', coordinates, source: 'osm-trace' }),
          JSON.stringify({
            osm_trace_id: trace.id,
            ...(match ? { place_ark_id: match.place.ark_id } : {}),
          }),
          trace.link,
          `osmtrace:${trace.id}`,
        ],
      );
      written++;
      if (match) linked++;
      items.push({
        id: trace.id,
        title: trace.title,
        status: 'written',
        points: coordinates.length,
        place: match?.place.name,
      });
    } catch {
      errors++;
      items.push({ id: trace.id, title: trace.title, status: 'error' });
    }
  }

  // 7. Дайджест админу — только если есть новое
  if (written > 0) {
    const lines = items
      .filter(i => i.status === 'written')
      .map(i => `• <a href="https://www.openstreetmap.org/traces/${i.id}">${esc(i.title)}</a> — ${i.points} тчк${i.place ? ` → ${esc(i.place)}` : ''}`);
    await tgSend(
      `<b>OSM Traces Scout</b>\nНовые GPS-треки по Камчатке: ${written} (привязано к местам: ${linked})\n\n${lines.join('\n')}\n\nТреки записаны скрытыми — ревью: vedarai.ru/hub/admin/content/routes`,
    );
  }

  return {
    feeds_ok: feedsOk,
    feed_errors: feedErrors,
    seen,
    in_bbox: candidates.length,
    new_traces: todo.length,
    written,
    linked,
    errors,
    duration_ms: Date.now() - t0,
    items,
  };
}
