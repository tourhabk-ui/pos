/**
 * POST /api/admin/import-tracks
 * Импортирует GPS-треки с idilesom.com в kamchatka_routes.geometry.
 * Скрейпит как /kam/places так и /kam/routes.
 * ID имеют префикс: "places:123" или "routes:456".
 * Работает батчами: ?offset=0&batch=5 → следующий вызов ?offset=5&batch=5 и т.д.
 *
 * Режимы:
 *  - Совпал с нашим маршрутом → обновляет geometry
 *  - Не совпал, но трек валидный камчатский → создаёт черновой маршрут (is_visible=false)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { fetchViaBrightData } from '@/lib/scraping/brightdata';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DELAY_MS = 500;
const MAX_MATCH_DIST_KM = 10;
// Камчатка: примерный bbox
const KAM_LAT_MIN = 50.5, KAM_LAT_MAX = 62.0;
const KAM_LNG_MIN = 155.0, KAM_LNG_MAX = 173.5;
const MIN_DRAFT_POINTS = 10;
const PLAIN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'ru-RU,ru;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

async function fetchHtml(url: string): Promise<string | null> {
  const bd = await fetchViaBrightData(url, { zone: 'web_unlocker1', country: 'ru' });
  if (bd) return bd;
  try {
    const res = await fetch(url, { headers: PLAIN_HEADERS });
    return res.ok ? res.text() : null;
  } catch { return null; }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function distKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function fetchSectionIds(section: 'places' | 'routes', maxPages = 50): Promise<string[]> {
  const all = new Set<string>();
  const baseUrl = `https://idilesom.com/kam/${section}`;
  const pattern = new RegExp(`/kam/${section}/(\\d+)`, 'g');

  const html = await fetchHtml(baseUrl);
  if (!html) return [];

  const firstMatches = html.match(pattern) ?? [];
  firstMatches.forEach(m => all.add(m.split('/').pop()!));

  for (let page = 2; page <= maxPages; page++) {
    await sleep(DELAY_MS);
    const pageHtml = await fetchHtml(`${baseUrl}?page=${page}`);
    if (!pageHtml) break;
    let ids: string[] = [];
    try {
      const data = JSON.parse(pageHtml) as { empty?: boolean; list?: string };
      if (data.empty) break;
      ids = (data.list?.match(pattern) ?? []).map(m => m.split('/').pop()!);
    } catch {
      ids = (pageHtml.match(pattern) ?? []).map(m => m.split('/').pop()!);
    }
    const before = all.size;
    ids.forEach(id => all.add(id));
    if (all.size === before) break;
  }

  return [...all].map(id => `${section}:${id}`);
}

async function fetchAllSourceIds(): Promise<string[]> {
  const [placeIds, routeIds] = await Promise.all([
    fetchSectionIds('places'),
    fetchSectionIds('routes'),
  ]);
  return [...placeIds, ...routeIds];
}

async function scrapeTrack(sourceId: string): Promise<{ title: string; lat: number; lng: number; coordinates: number[][] } | null> {
  const colonIdx = sourceId.indexOf(':');
  const section = colonIdx >= 0 ? sourceId.slice(0, colonIdx) : 'places';
  const id = colonIdx >= 0 ? sourceId.slice(colonIdx + 1) : sourceId;

  const html = await fetchHtml(`https://idilesom.com/kam/${section}/${id}`);
  if (!html) return null;

  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';

  const coordBlocks = html.match(/\[\s*\[\s*[\d.]+\s*,\s*[\d.]+[\s\S]*?\]\s*\]/g) ?? [];
  let bestCoords: number[][] = [];

  for (const block of coordBlocks) {
    try {
      const parsed = JSON.parse(block) as number[][];
      if (!Array.isArray(parsed) || parsed.length < 3 || !Array.isArray(parsed[0]) || parsed[0].length < 2) continue;
      const first = parsed[0];
      const isGeoJSON = Math.abs(first[0]) > 90;
      const coords: number[][] = isGeoJSON
        ? parsed.map(p => p.length >= 3 ? [p[0], p[1], p[2]] : [p[0], p[1]])
        : parsed.map(p => [p[1], p[0]]);
      if (coords.length > bestCoords.length) bestCoords = coords;
    } catch { /* skip */ }
  }

  if (bestCoords.length < 3) return null;

  const mid = bestCoords[Math.floor(bestCoords.length / 2)];
  return { title, lat: mid[1], lng: mid[0], coordinates: bestCoords };
}

interface OurRoute { id: string; title: string; lat: number; lng: number; hasGeometry: boolean; }

async function loadOurRoutes(skipExisting: boolean): Promise<OurRoute[]> {
  const { rows } = await pool.query<{ id: string; title: string; lat: string; lng: string; has_geom: boolean }>(
    `SELECT id, title, lat::text, lng::text,
            (geometry IS NOT NULL AND jsonb_array_length(geometry->'coordinates') > 1) AS has_geom
     FROM kamchatka_routes
     WHERE is_visible = true AND lat IS NOT NULL AND lng IS NOT NULL
     ORDER BY title`
  );
  return rows
    .filter(r => !skipExisting || !r.has_geom)
    .map(r => ({ id: r.id, title: r.title, lat: parseFloat(r.lat), lng: parseFloat(r.lng), hasGeometry: r.has_geom }));
}

// Загружаем координаты existing places чтобы не создавать дубли в kamchatka_routes
async function loadPlaceCoords(): Promise<{ lat: number; lng: number }[]> {
  const { rows } = await pool.query<{ lat: string; lng: string }>(
    `SELECT lat::text, lng::text FROM places WHERE is_visible = true AND lat IS NOT NULL AND lng IS NOT NULL`
  );
  return rows.map(r => ({ lat: parseFloat(r.lat), lng: parseFloat(r.lng) }));
}

function isNearAnyPlace(track: { lat: number; lng: number; coordinates: number[][] }, places: { lat: number; lng: number }[]): boolean {
  const coords = track.coordinates;
  const checkPoints: [number, number][] = [
    [coords[0][1], coords[0][0]],
    [track.lat, track.lng],
    [coords[coords.length - 1][1], coords[coords.length - 1][0]],
  ];
  // Если трек "вокруг" уже известного места (≤2 км) — это не новый маршрут, это место
  return places.some(p => Math.min(...checkPoints.map(([lat, lng]) => distKm(lat, lng, p.lat, p.lng))) <= 2);
}

function isInKamchatka(lat: number, lng: number): boolean {
  return lat >= KAM_LAT_MIN && lat <= KAM_LAT_MAX && lng >= KAM_LNG_MIN && lng <= KAM_LNG_MAX;
}

function calcTrackDistKm(coords: number[][]): number {
  let d = 0;
  for (let i = 1; i < coords.length; i++) {
    d += distKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  }
  return Math.round(d * 10) / 10;
}

function sourceIdToUrl(sourceId: string): string {
  const colonIdx = sourceId.indexOf(':');
  const section = colonIdx >= 0 ? sourceId.slice(0, colonIdx) : 'places';
  const id = colonIdx >= 0 ? sourceId.slice(colonIdx + 1) : sourceId;
  return `https://idilesom.com/kam/${section}/${id}`;
}

function findMatch(track: { lat: number; lng: number; coordinates: number[][] }, routes: OurRoute[]): { route: OurRoute; distKm: number } | null {
  const coords = track.coordinates;
  const checkPoints: [number, number][] = [
    [coords[0][1], coords[0][0]],
    [track.lat, track.lng],
    [coords[coords.length - 1][1], coords[coords.length - 1][0]],
  ];

  let best: OurRoute | null = null;
  let bestDist = MAX_MATCH_DIST_KM;
  for (const r of routes) {
    if (r.hasGeometry) continue;
    const minDist = Math.min(...checkPoints.map(([lat, lng]) => distKm(lat, lng, r.lat, r.lng)));
    if (minDist < bestDist) { bestDist = minDist; best = r; }
  }
  return best ? { route: best, distKm: Math.round(bestDist * 10) / 10 } : null;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const authResult = await requireAdmin(req);
  if (authResult instanceof NextResponse) return authResult;

  const { searchParams } = new URL(req.url);
  const offset = Math.max(0, parseInt(searchParams.get('offset') ?? '0'));
  const batch = Math.min(50, Math.max(1, parseInt(searchParams.get('batch') ?? '5')));
  const skipExisting = searchParams.get('skip_existing') !== 'false';

  const log: string[] = [];
  const matches: { ourTitle: string; sourceTitle: string; pts: number; distKm: number; routeId: string }[] = [];
  const drafts: { title: string; pts: number; distKm: number; sourceUrl: string }[] = [];
  let imported = 0, skipped = 0, noMatch = 0, created = 0, errors = 0;

  try {
    const [ourRoutes, placeCoords] = await Promise.all([
      loadOurRoutes(skipExisting),
      loadPlaceCoords(),
    ]);

    let allIds: string[];
    let clientIds: string[] | null = null;
    try {
      const body = await req.json() as { ids?: string[] };
      if (Array.isArray(body?.ids) && body.ids.length > 0) clientIds = body.ids;
    } catch { /* no body */ }

    log.push(`Наших маршрутов без трека: ${ourRoutes.length}`);

    if (clientIds) {
      allIds = clientIds;
    } else {
      log.push('Собираем ID с idilesom.com (places + routes)...');
      allIds = await fetchAllSourceIds();
      const placesCount = allIds.filter(id => id.startsWith('places:')).length;
      const routesCount = allIds.filter(id => id.startsWith('routes:')).length;
      log.push(`  Найдено ${allIds.length} источников (места: ${placesCount}, маршруты: ${routesCount})`);
    }

    if (ourRoutes.length === 0) {
      return NextResponse.json({ success: true, imported: 0, skipped: 0, noMatch: 0, errors: 0, matches: [], batch_processed: 0, offset, next_offset: offset, total_ids: allIds.length, done: true, log: [...log, 'Все маршруты уже имеют треки — нечего импортировать'] });
    }

    const totalIds = allIds.length;
    const ids = allIds.slice(offset, offset + batch);
    log.push(`  Обрабатываем [${offset}…${offset + ids.length - 1}] из ${totalIds}`);

    for (let i = 0; i < ids.length; i++) {
      const sourceId = ids[i];
      try {
        const track = await scrapeTrack(sourceId);
        if (!track) { skipped++; await sleep(DELAY_MS); continue; }

        const found = findMatch(track, ourRoutes);

        if (!found) {
          // Не совпал с нашим маршрутом — создаём черновой если в Камчатке
          if (track.coordinates.length >= MIN_DRAFT_POINTS && isInKamchatka(track.lat, track.lng) && track.title) {
            // Не создавать маршрут если это уже есть как place (≤2 км от известного места)
            if (isNearAnyPlace(track, placeCoords)) {
              noMatch++;
              log.push(`  [${offset + i + 1}/${totalIds}] SKIP (уже place): "${track.title.slice(0, 50)}"`);
            } else {
              const geojson = { type: 'LineString', coordinates: track.coordinates, source: 'idilesom' };
              const trackLen = calcTrackDistKm(track.coordinates);
              const srcUrl = sourceIdToUrl(sourceId);
              const dedupeKey = `idilesom:${sourceId}`;
              await pool.query(
                `INSERT INTO kamchatka_routes (title, lat, lng, geometry, source_url, source_name, is_visible, dedupe_key)
                 VALUES ($1,$2,$3,$4,$5,'idilesom',false,$6)
                 ON CONFLICT (dedupe_key) DO NOTHING`,
                [track.title, track.lat, track.lng, JSON.stringify(geojson), srcUrl, dedupeKey]
              );
              created++;
              drafts.push({ title: track.title, pts: track.coordinates.length, distKm: trackLen, sourceUrl: srcUrl });
              log.push(`  [${offset + i + 1}/${totalIds}] NEW: "${track.title.slice(0, 50)}" (${track.coordinates.length} pts, ${trackLen} км) → черновик`);
            }
          } else {
            noMatch++;
          }
          await sleep(DELAY_MS);
          continue;
        }

        const geojson = { type: 'LineString', coordinates: track.coordinates, source: 'idilesom' };
        await pool.query(
          'UPDATE kamchatka_routes SET geometry = $1, source_url = COALESCE(source_url, $3) WHERE id = $2',
          [JSON.stringify(geojson), found.route.id, sourceIdToUrl(sourceId)]
        );
        found.route.hasGeometry = true;

        imported++;
        matches.push({ ourTitle: found.route.title, sourceTitle: track.title, pts: track.coordinates.length, distKm: found.distKm, routeId: found.route.id });
        log.push(`  [${offset + i + 1}/${totalIds}] OK: "${found.route.title.slice(0, 40)}" ← "${track.title.slice(0, 35)}" (${track.coordinates.length} pts, ${found.distKm} км)`);
      } catch (err) {
        errors++;
        log.push(`  [${offset + i + 1}] ERROR id=${sourceId}: ${(err as Error).message.slice(0, 60)}`);
      }
      await sleep(DELAY_MS);
    }

    const nextOffset = offset + ids.length;
    const done = nextOffset >= totalIds;

    return NextResponse.json({
      success: true,
      imported,
      created,
      skipped,
      noMatch,
      errors,
      matches,
      drafts,
      batch_processed: ids.length,
      offset,
      next_offset: nextOffset,
      total_ids: totalIds,
      done,
      all_ids: clientIds ? undefined : allIds,
      log,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: (err as Error).message, log },
      { status: 500 }
    );
  }
}
