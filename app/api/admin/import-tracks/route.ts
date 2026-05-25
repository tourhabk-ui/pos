/**
 * POST /api/admin/import-tracks
 * Импортирует GPS-треки с idilesom.com в kamchatka_routes.geometry.
 * Scrapes HTML directly — no BrightData required.
 *
 * ?page=N      — одна конкретная страница idilesom (для отладки)
 * ?limit=N     — максимум N мест обработать (default 500)
 * ?skip_existing=true — пропускать маршруты у которых уже есть geometry
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const DELAY_MS = 800;
const MAX_MATCH_DIST_KM = 5;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'ru-RU,ru;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

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

  const r1 = await fetch('https://idilesom.com/kam/places', { headers: HEADERS });
  if (!r1.ok) throw new Error(`idilesom page 1 returned ${r1.status}`);
  const html = await r1.text();
  (html.match(/\/kam\/places\/(\d+)/g) ?? []).forEach(m => all.add(m.split('/').pop()!));

  for (let page = 2; page <= maxPages; page++) {
    await sleep(DELAY_MS);
    const res = await fetch(`https://idilesom.com/kam/places?page=${page}`, {
      headers: { ...HEADERS, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
    });
    if (!res.ok) break;
    const data = await res.json() as { empty?: boolean; list?: string };
    if (data.empty) break;
    const ids = (data.list?.match(/\/kam\/places\/(\d+)/g) ?? []).map(m => m.split('/').pop()!);
    const before = all.size;
    ids.forEach(id => all.add(id));
    if (all.size === before) break; // no new ids
  }

  return [...all];
}

async function scrapeTrack(placeId: string): Promise<{ title: string; lat: number; lng: number; coordinates: number[][] } | null> {
  const res = await fetch(`https://idilesom.com/kam/places/${placeId}`, { headers: HEADERS });
  if (!res.ok) return null;
  const html = await res.text();

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

function findMatch(track: { lat: number; lng: number; coordinates: number[][] }, routes: OurRoute[]): OurRoute | null {
  const tLat = track.coordinates[0][1];
  const tLng = track.coordinates[0][0];
  let best: OurRoute | null = null;
  let bestDist = MAX_MATCH_DIST_KM;
  for (const r of routes) {
    if (r.hasGeometry) continue;
    const d = distKm(tLat, tLng, r.lat, r.lng);
    if (d < bestDist) { bestDist = d; best = r; }
  }
  return best;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const authError = await requireAdmin(req);
  if (authError) return authError;

  const { searchParams } = new URL(req.url);
  const limit = Math.min(1000, parseInt(searchParams.get('limit') ?? '500'));
  const skipExisting = searchParams.get('skip_existing') !== 'false';

  const log: string[] = [];
  let imported = 0, skipped = 0, noMatch = 0, errors = 0;

  try {
    log.push('Загружаем наши маршруты...');
    const ourRoutes = await loadOurRoutes(skipExisting);
    log.push(`  ${ourRoutes.length} маршрутов для обновления`);

    log.push('Собираем ID мест с idilesom.com...');
    const allIds = await fetchPlaceIds(50);
    const ids = allIds.slice(0, limit);
    log.push(`  Найдено ${allIds.length} мест, обработаем ${ids.length}`);

    for (let i = 0; i < ids.length; i++) {
      const placeId = ids[i];
      try {
        const track = await scrapeTrack(placeId);
        if (!track) { skipped++; await sleep(DELAY_MS); continue; }

        const match = findMatch(track, ourRoutes);
        if (!match) { noMatch++; await sleep(DELAY_MS); continue; }

        const geojson = { type: 'LineString', coordinates: track.coordinates, source: 'idilesom' };
        await pool.query('UPDATE kamchatka_routes SET geometry = $1 WHERE id = $2', [JSON.stringify(geojson), match.id]);
        match.hasGeometry = true;

        imported++;
        log.push(`  [${i + 1}/${ids.length}] OK: "${match.title.slice(0, 40)}" ← "${track.title.slice(0, 35)}" (${track.coordinates.length} pts)`);
      } catch (err) {
        errors++;
        log.push(`  [${i + 1}] ERROR id=${placeId}: ${(err as Error).message.slice(0, 60)}`);
      }
      await sleep(DELAY_MS);
    }

    return NextResponse.json({
      success: true,
      imported,
      skipped,
      noMatch,
      errors,
      total_processed: ids.length,
      log,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: (err as Error).message, log },
      { status: 500 }
    );
  }
}
