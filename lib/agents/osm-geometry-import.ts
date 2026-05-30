/**
 * lib/agents/osm-geometry-import.ts
 *
 * Загружает GPS-треки из OpenStreetMap Overpass API для маршрутов
 * у которых geometry IS NULL. Используется в:
 *   - /api/admin/import/osm-geometry (admin UI, dry_run поддержка)
 *   - /api/cron/osm-geometry (автоматический запуск каждые 8 часов)
 */

import { pool } from '@/lib/db-pool';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const DELAY_MS = 1300;
const RADIUS_DEG_LAT = 0.07;
const RADIUS_DEG_LNG = 0.10;
const MAX_START_DIST_KM = 4;

export interface OsmImportResult {
  imported: number;
  skipped: number;
  errors: number;
  error_details: string[];
  routes_without_geometry: number;
  processed: number;
  details: Array<{ id: string; title: string; status: string; pts?: number }>;
}

function distKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

interface OsmNode { lat: number; lon: number; }
interface OsmWay { id: number; tags: Record<string, string>; geometry: OsmNode[]; }

async function fetchOsmWays(lat: number, lng: number): Promise<OsmWay[]> {
  const s = lat - RADIUS_DEG_LAT;
  const n = lat + RADIUS_DEG_LAT;
  const w = lng - RADIUS_DEG_LNG;
  const e = lng + RADIUS_DEG_LNG;
  const q = `[out:json][timeout:25];way["highway"~"path|track|footway"](${s},${w},${n},${e});out geom;`;

  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(q)}`,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const data = await res.json() as { elements: OsmWay[] };
  return (data.elements ?? []).filter(e => e.geometry && e.geometry.length >= 3);
}

function pickBestWay(ways: OsmWay[], lat: number, lng: number): OsmWay | null {
  const scored = ways.map(way => {
    const first = way.geometry[0];
    const last = way.geometry[way.geometry.length - 1];
    const startDist = Math.min(
      distKm(lat, lng, first.lat, first.lon),
      distKm(lat, lng, last.lat, last.lon),
    );
    return { way, startDist, nodeCount: way.geometry.length };
  });
  const nearby = scored.filter(s => s.startDist <= MAX_START_DIST_KM);
  if (nearby.length === 0) return null;
  nearby.sort((a, b) => b.nodeCount - a.nodeCount);
  return nearby[0].way;
}

function wayToGeoJSON(way: OsmWay, routeLat: number, routeLng: number) {
  const first = way.geometry[0];
  const last = way.geometry[way.geometry.length - 1];
  const distFirst = distKm(routeLat, routeLng, first.lat, first.lon);
  const distLast = distKm(routeLat, routeLng, last.lat, last.lon);
  const coords =
    distLast < distFirst
      ? [...way.geometry].reverse().map(n => [n.lon, n.lat])
      : way.geometry.map(n => [n.lon, n.lat]);
  return { type: 'LineString', coordinates: coords };
}

export async function runOsmGeometryImport(
  limit = 40,
  dry_run = false,
): Promise<OsmImportResult> {
  const { rows: routes } = await pool.query<{
    id: string; title: string; lat: string; lng: string;
  }>(`
    SELECT id, title, lat::text, lng::text
    FROM kamchatka_routes
    WHERE is_visible = true
      AND lat IS NOT NULL AND lng IS NOT NULL
      AND geometry IS NULL
    ORDER BY title
    LIMIT $1
  `, [limit]);

  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM kamchatka_routes
     WHERE is_visible = true AND lat IS NOT NULL AND lng IS NOT NULL AND geometry IS NULL`,
  );

  let imported = 0;
  let skipped = 0;
  const errorMessages: string[] = [];
  const details: OsmImportResult['details'] = [];

  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    const lat = parseFloat(r.lat);
    const lng = parseFloat(r.lng);

    try {
      const ways = await fetchOsmWays(lat, lng);
      const best = pickBestWay(ways, lat, lng);

      if (!best) {
        skipped++;
        details.push({ id: r.id, title: r.title, status: 'skipped' });
      } else {
        const geojson = wayToGeoJSON(best, lat, lng);
        if (!dry_run) {
          await pool.query(
            `UPDATE kamchatka_routes SET geometry = $1 WHERE id = $2`,
            [JSON.stringify(geojson), r.id],
          );
        }
        imported++;
        details.push({ id: r.id, title: r.title, status: dry_run ? 'dry_run' : 'imported', pts: geojson.coordinates.length });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errorMessages.push(`${r.title}: ${msg}`);
      details.push({ id: r.id, title: r.title, status: 'error' });
    }

    if (i < routes.length - 1) {
      await new Promise(res => setTimeout(res, DELAY_MS));
    }
  }

  return {
    imported,
    skipped,
    errors: errorMessages.length,
    error_details: errorMessages.slice(0, 10),
    routes_without_geometry: parseInt(countRows[0].count) - imported,
    processed: routes.length,
    details: details.slice(0, 50),
  };
}
