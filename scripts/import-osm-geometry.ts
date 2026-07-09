/**
 * scripts/import-osm-geometry.ts
 *
 * Fetches real GPS track geometry from OpenStreetMap Overpass API
 * for kamchatka_routes that have no geometry yet.
 *
 * For each route (lat/lng center), queries Overpass for hiking/track paths
 * within a ~10km bounding box, picks the longest continuous way that starts
 * within 3km of the route center, and stores it as GeoJSON LineString.
 *
 * Usage:
 *   DATABASE_URL=<prod> npx tsx scripts/import-osm-geometry.ts
 *   DATABASE_URL=<prod> npx tsx scripts/import-osm-geometry.ts --dry-run
 *   DATABASE_URL=<prod> npx tsx scripts/import-osm-geometry.ts --limit 20
 */

import { pool } from '../lib/db-pool';
import {
  buildOverpassQuery, parseOverpassWays, pickBestWay, wayToGeoJSON,
  type OsmWay,
} from '../lib/import/osm-geometry';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const DELAY_MS = 1200; // stay well below Overpass rate limit

const isDryRun = process.argv.includes('--dry-run');
const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg !== -1 ? parseInt(process.argv[limitArg + 1]) : 999;

// ─── Overpass fetch (сеть) — чистая логика в lib/import/osm-geometry.ts ─────────

async function fetchOsmWays(lat: number, lng: number): Promise<OsmWay[]> {
  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(buildOverpassQuery(lat, lng))}`,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  return parseOverpassWays(await res.json());
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { rows: routes } = await pool.query<{
    id: string;
    title: string;
    lat: string;
    lng: string;
  }>(`
    SELECT id, title, lat::text, lng::text
    FROM kamchatka_routes
    WHERE is_visible = true
      AND lat IS NOT NULL
      AND lng IS NOT NULL
      AND geometry IS NULL
    ORDER BY title
    LIMIT $1
  `, [LIMIT]);

  console.log(`Routes without geometry: ${routes.length}`);
  if (isDryRun) console.log('[dry-run mode — no DB writes]');

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    const lat = parseFloat(r.lat);
    const lng = parseFloat(r.lng);
    process.stdout.write(`[${i + 1}/${routes.length}] ${r.title.slice(0, 50).padEnd(50)} `);

    try {
      const ways = await fetchOsmWays(lat, lng);
      const best = pickBestWay(ways, lat, lng);

      if (!best) {
        process.stdout.write(`skip (0/${ways.length} ways in range)\n`);
        skipped++;
      } else {
        const geojson = wayToGeoJSON(best, lat, lng);
        const pts = geojson.coordinates.length;

        if (!isDryRun) {
          await pool.query(
            `UPDATE kamchatka_routes SET geometry = $1 WHERE id = $2`,
            [JSON.stringify(geojson), r.id],
          );
        }

        const name = best.tags?.name ?? 'unnamed';
        process.stdout.write(`OK (${pts} pts, way "${name}")\n`);
        imported++;
      }
    } catch (err) {
      process.stdout.write(`ERROR: ${(err as Error).message}\n`);
      errors++;
    }

    // Rate-limit pause (skip after last item)
    if (i < routes.length - 1) await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`\nDone: ${imported} imported, ${skipped} skipped, ${errors} errors`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
