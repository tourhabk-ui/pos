#!/usr/bin/env npx tsx
/**
 * scripts/link-places-to-routes.ts
 *
 * Находит места (places) без маршрутов и связывает их с kamchatka_routes
 * через route_waypoints, используя два критерия:
 *   1. Совпадение названий (место упоминается в заголовке/описании маршрута)
 *   2. Географическая близость (место в радиусе 15 км от центра маршрута)
 *
 * Запуск:
 *   npx tsx scripts/link-places-to-routes.ts --dry-run   -- без записи в БД
 *   npx tsx scripts/link-places-to-routes.ts             -- пишем в БД
 *   npx tsx scripts/link-places-to-routes.ts --stats     -- статистика
 *   npx tsx scripts/link-places-to-routes.ts --radius=20 -- радиус км (default 15)
 */

import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

function loadEnv() {
  for (const f of ['.env.local', '.env']) {
    const p = path.resolve(process.cwd(), f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    break;
  }
}
loadEnv();

const DB_URL   = process.env.DATABASE_URL ?? '';
const DRY_RUN  = process.argv.includes('--dry-run');
const STATS    = process.argv.includes('--stats');
const RADIUS   = parseFloat(process.argv.find(a => a.startsWith('--radius='))?.split('=')[1] ?? '15');

if (!DB_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

const pool = new Pool({
  connectionString: DB_URL,
  ssl: DB_URL.includes('sslmode') ? { rejectUnauthorized: false } : undefined,
  max: 3,
});

// ── Haversine ─────────────────────────────────────────────────────────────────

function distKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Совпадение названий ───────────────────────────────────────────────────────

function nameMatch(placeName: string, routeTitle: string, routeDesc: string | null): boolean {
  const pn = placeName.toLowerCase().replace(/[^а-яёa-z\s]/gi, '');
  const rt = (routeTitle + ' ' + (routeDesc ?? '')).toLowerCase();

  // Минимум 6 символов для совпадения
  const words = pn.split(/\s+/).filter(w => w.length >= 6);
  return words.some(w => rt.includes(w));
}

// ── Статистика ────────────────────────────────────────────────────────────────

async function showStats() {
  const r1 = await pool.query('SELECT COUNT(*) FROM places');
  const r2 = await pool.query(`
    SELECT COUNT(*) FROM places p
    WHERE NOT EXISTS (SELECT 1 FROM route_waypoints rw WHERE rw.place_id = p.id)
  `);
  const r3 = await pool.query('SELECT COUNT(*) FROM route_waypoints');
  const r4 = await pool.query('SELECT COUNT(DISTINCT place_id) FROM route_waypoints');
  console.log(`\n  places:          ${r1.rows[0].count}`);
  console.log(`  без маршрутов:   ${r2.rows[0].count}`);
  console.log(`  route_waypoints: ${r3.rows[0].count}`);
  console.log(`  мест в waypoints: ${r4.rows[0].count}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (STATS) { await showStats(); await pool.end(); return; }

  console.log(`\nlink-places-to-routes | radius=${RADIUS}km | dry=${DRY_RUN}\n`);

  // Загружаем все места с координатами
  const placesRes = await pool.query<{
    id: string; name: string; lat: string; lng: string; location_type: string;
  }>(`
    SELECT id, name, lat::float, lng::float, location_type
    FROM places
    WHERE lat IS NOT NULL AND lng IS NOT NULL
    ORDER BY name
  `);
  console.log(`  Места с координатами: ${placesRes.rows.length}`);

  // Места уже в route_waypoints
  const existingRes = await pool.query<{ place_id: string }>(`
    SELECT DISTINCT place_id FROM route_waypoints
  `);
  const existing = new Set(existingRes.rows.map(r => r.place_id));
  console.log(`  Уже связаны: ${existing.size}`);

  const unlinked = placesRes.rows.filter(p => !existing.has(p.id));
  console.log(`  Не связаны:  ${unlinked.length}\n`);

  // Загружаем маршруты с координатами
  const routesRes = await pool.query<{
    id: string; title: string; lat: string | null; lng: string | null; description: string | null;
  }>(`
    SELECT id, title, lat::float, lng::float, LEFT(description, 300) AS description
    FROM kamchatka_routes
    WHERE lat IS NOT NULL AND lng IS NOT NULL
    ORDER BY title
  `);
  console.log(`  Маршруты с координатами: ${routesRes.rows.length}\n`);

  const routes = routesRes.rows;
  let linked = 0, skipped = 0;

  for (const place of unlinked) {
    const lat = parseFloat(place.lat as unknown as string);
    const lng = parseFloat(place.lng as unknown as string);

    // Ищем маршруты: сначала по названию, потом по близости
    const candidates: Array<{ routeId: string; title: string; dist: number; reason: string }> = [];

    for (const route of routes) {
      const rLat = parseFloat(route.lat as unknown as string);
      const rLng = parseFloat(route.lng as unknown as string);
      const dist = distKm(lat, lng, rLat, rLng);

      const byName = nameMatch(place.name, route.title, route.description);
      const byGeo  = dist <= RADIUS;

      if (byName || byGeo) {
        candidates.push({
          routeId: route.id,
          title:   route.title,
          dist:    Math.round(dist * 10) / 10,
          reason:  byName ? (byGeo ? 'name+geo' : 'name') : 'geo',
        });
      }
    }

    // Сортируем: name+geo → name → geo (по расстоянию)
    candidates.sort((a, b) => {
      const priority = (r: typeof a) => r.reason === 'name+geo' ? 0 : r.reason === 'name' ? 1 : 2;
      if (priority(a) !== priority(b)) return priority(a) - priority(b);
      return a.dist - b.dist;
    });

    // Берём топ 3 маршрута (не больше)
    const top = candidates.slice(0, 3);

    if (top.length === 0) {
      skipped++;
      continue;
    }

    console.log(`${place.name} [${place.location_type}]:`);
    for (let pos = 0; pos < top.length; pos++) {
      const c = top[pos];
      console.log(`  -> ${c.title} (${c.dist}km, ${c.reason})`);

      if (!DRY_RUN) {
        await pool.query(
          `INSERT INTO route_waypoints (route_id, place_id, position)
           VALUES ($1::uuid, $2::uuid, $3)
           ON CONFLICT (route_id, place_id) DO NOTHING`,
          [c.routeId, place.id, pos],
        );
        linked++;
      } else {
        linked++;
      }
    }
  }

  console.log(`\nИтого: +${linked} связей создано, ${skipped} мест без совпадений`);

  if (!DRY_RUN) {
    console.log('\nСтатистика после:');
    await showStats();
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
