/**
 * POST /api/admin/import-tracks
 * Импортирует GPS-треки с idilesom.com в kamchatka_routes.geometry.
 * Работает батчами: ?offset=0&batch=25 → следующий вызов ?offset=25&batch=25 и т.д.
 *
 * ?offset=N      — начать с N-го плейса (default 0)
 * ?batch=N       — обработать N мест за вызов (default 25, max 50)
 * ?skip_existing=true — пропускать маршруты у которых уже есть geometry
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { fetchViaBrightData } from '@/lib/scraping/brightdata';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DELAY_MS = 500;
const MAX_MATCH_DIST_KM = 5;
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

async function fetchPlaceIds(maxPages = 50): Promise<string[]> {
  const all = new Set<string>();

  const html = await fetchHtml('https://idilesom.com/kam/places');
  if (!html) throw new Error('Не удалось загрузить idilesom.com/kam/places');
  (html.match(/\/kam\/places\/(\d+)/g) ?? []).forEach(m => all.add(m.split('/').pop()!));

  for (let page = 2; page <= maxPages; page++) {
    await sleep(DELAY_MS);
    const pageHtml = await fetchHtml(`https://idilesom.com/kam/places?page=${page}`);
    if (!pageHtml) break;
    let ids: string[] = [];
    try {
      const data = JSON.parse(pageHtml) as { empty?: boolean; list?: string };
      if (data.empty) break;
      ids = (data.list?.match(/\/kam\/places\/(\d+)/g) ?? []).map(m => m.split('/').pop()!);
    } catch {
      ids = (pageHtml.match(/\/kam\/places\/(\d+)/g) ?? []).map(m => m.split('/').pop()!);
    }
    const before = all.size;
    ids.forEach(id => all.add(id));
    if (all.size === before) break;
  }

  return [...all];
}

async function scrapeTrack(placeId: string): Promise<{ title: string; lat: number; lng: number; coordinates: number[][] } | null> {
  const html = await fetchHtml(`https://idilesom.com/kam/places/${placeId}`);
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

function findMatch(track: { lat: number; lng: number; coordinates: number[][] }, routes: OurRoute[]): { route: OurRoute; distKm: number } | null {
  const tLat = track.coordinates[0][1];
  const tLng = track.coordinates[0][0];
  let best: OurRoute | null = null;
  let bestDist = MAX_MATCH_DIST_KM;
  for (const r of routes) {
    if (r.hasGeometry) continue;
    const d = distKm(tLat, tLng, r.lat, r.lng);
    if (d < bestDist) { bestDist = d; best = r; }
  }
  return best ? { route: best, distKm: Math.round(bestDist * 10) / 10 } : null;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const authError = await requireAdmin(req);
  if (authError) return authError;

  const { searchParams } = new URL(req.url);
  const offset = Math.max(0, parseInt(searchParams.get('offset') ?? '0'));
  const batch = Math.min(50, Math.max(1, parseInt(searchParams.get('batch') ?? '25')));
  const skipExisting = searchParams.get('skip_existing') !== 'false';

  const log: string[] = [];
  const matches: { ourTitle: string; sourceTitle: string; pts: number; distKm: number; routeId: string }[] = [];
  let imported = 0, skipped = 0, noMatch = 0, errors = 0;

  try {
    const ourRoutes = await loadOurRoutes(skipExisting);

    let allIds: string[];
    let clientIds: string[] | null = null;
    try {
      const body = await req.json() as { ids?: string[] };
      if (Array.isArray(body?.ids) && body.ids.length > 0) clientIds = body.ids;
    } catch { /* no body */ }

    if (clientIds) {
      allIds = clientIds;
    } else {
      log.push('Собираем ID мест с idilesom.com...');
      allIds = await fetchPlaceIds(50);
      log.push(`  Найдено ${allIds.length} мест`);
    }

    const totalIds = allIds.length;
    const ids = allIds.slice(offset, offset + batch);
    log.push(`  Обрабатываем [${offset}…${offset + ids.length - 1}] из ${totalIds}`);

    for (let i = 0; i < ids.length; i++) {
      const placeId = ids[i];
      try {
        const track = await scrapeTrack(placeId);
        if (!track) { skipped++; await sleep(DELAY_MS); continue; }

        const found = findMatch(track, ourRoutes);
        if (!found) { noMatch++; await sleep(DELAY_MS); continue; }

        const geojson = { type: 'LineString', coordinates: track.coordinates, source: 'idilesom' };
        await pool.query('UPDATE kamchatka_routes SET geometry = $1 WHERE id = $2', [JSON.stringify(geojson), found.route.id]);
        found.route.hasGeometry = true;

        imported++;
        matches.push({ ourTitle: found.route.title, sourceTitle: track.title, pts: track.coordinates.length, distKm: found.distKm, routeId: found.route.id });
        log.push(`  [${offset + i + 1}/${totalIds}] OK: "${found.route.title.slice(0, 40)}" ← "${track.title.slice(0, 35)}" (${track.coordinates.length} pts, ${found.distKm} км)`);
      } catch (err) {
        errors++;
        log.push(`  [${offset + i + 1}] ERROR id=${placeId}: ${(err as Error).message.slice(0, 60)}`);
      }
      await sleep(DELAY_MS);
    }

    const nextOffset = offset + ids.length;
    const done = nextOffset >= totalIds;

    return NextResponse.json({
      success: true,
      imported,
      skipped,
      noMatch,
      errors,
      matches,
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
