/**
 * scripts/compare-idilesom.ts
 *
 * Быстрое сравнение: сколько мест/маршрутов в нашей БД vs сколько на idilesom.com/kam/places
 * Не вставляет ничего — только считает и показывает разницу.
 *
 * Usage:
 *   npx tsx scripts/compare-idilesom.ts
 */

import { pool } from '../lib/db-pool';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
  'Accept-Language': 'ru-RU,ru;q=0.9',
};

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchIdilesomIds(): Promise<string[]> {
  const all = new Set<string>();

  process.stdout.write('Fetching idilesom page 1... ');
  const r1 = await fetch('https://idilesom.com/kam/places', { headers: HEADERS });
  const html = await r1.text();
  (html.match(/\/kam\/places\/(\d+)/g) ?? []).forEach(m => all.add(m.split('/').pop()!));
  process.stdout.write(`${all.size} IDs\n`);

  for (let page = 2; page <= 50; page++) {
    await sleep(300);
    process.stdout.write(`  page ${page}... `);
    const res = await fetch(`https://idilesom.com/kam/places?page=${page}`, {
      headers: { ...HEADERS, 'X-Requested-With': 'XMLHttpRequest' },
    });
    const data = await res.json() as { empty?: boolean; list?: string };
    if (data.empty) { process.stdout.write('empty, done.\n'); break; }
    const before = all.size;
    (data.list?.match(/\/kam\/places\/(\d+)/g) ?? []).forEach(m => all.add(m.split('/').pop()!));
    process.stdout.write(`+${all.size - before} (total: ${all.size})\n`);
  }

  return [...all];
}

async function main() {
  console.log('=== idilesom.com vs our DB ===\n');

  // ── Our DB counts ──────────────────────────────────────────────────────────
  const { rows: placeRows } = await pool.query<{ source_name: string; cnt: string }>(`
    SELECT COALESCE(source_name, 'unknown') AS source_name, COUNT(*) AS cnt
    FROM places WHERE is_visible = true
    GROUP BY source_name ORDER BY cnt::int DESC
  `);
  const { rows: routeRows } = await pool.query<{ source_name: string; cnt: string }>(`
    SELECT COALESCE(source_name, 'unknown') AS source_name, COUNT(*) AS cnt
    FROM kamchatka_routes WHERE is_visible = true
    GROUP BY source_name ORDER BY cnt::int DESC
  `);
  const { rows: [{ total_places }] } = await pool.query<{ total_places: string }>(
    `SELECT COUNT(*) AS total_places FROM places WHERE is_visible = true`
  );
  const { rows: [{ total_routes }] } = await pool.query<{ total_routes: string }>(
    `SELECT COUNT(*) AS total_routes FROM kamchatka_routes WHERE is_visible = true`
  );

  const idilesomPlaces = placeRows.find(r => r.source_name === 'idilesom.com')?.cnt ?? '0';
  const idilesomRoutes = routeRows.find(r => r.source_name === 'idilesom.com')?.cnt ?? '0';

  console.log('📍 places (is_visible=true):');
  console.log(`   Total: ${total_places}`);
  for (const r of placeRows) {
    console.log(`   ${r.source_name.padEnd(30)} ${r.cnt}`);
  }

  console.log('\n🗺️  kamchatka_routes (is_visible=true):');
  console.log(`   Total: ${total_routes}`);
  for (const r of routeRows) {
    console.log(`   ${r.source_name.padEnd(30)} ${r.cnt}`);
  }

  console.log('\n─── idilesom.com in our DB ───────────────');
  console.log(`   places from idilesom:  ${idilesomPlaces}`);
  console.log(`   routes from idilesom:  ${idilesomRoutes}`);

  // ── idilesom.com ───────────────────────────────────────────────────────────
  console.log('\n─── Fetching idilesom.com/kam/places IDs ─');
  const ids = await fetchIdilesomIds();

  console.log(`\n=== РЕЗУЛЬТАТ ===`);
  console.log(`idilesom.com entries:  ${ids.length}`);
  console.log(`Our places total:      ${total_places}`);
  console.log(`Our routes total:      ${total_routes}`);
  console.log(`Our combined total:    ${parseInt(total_places) + parseInt(total_routes)}`);
  console.log(`\nidilesom in our places: ${idilesomPlaces}`);
  console.log(`idilesom in our routes: ${idilesomRoutes}`);
  console.log(`idilesom total in DB:   ${parseInt(idilesomPlaces) + parseInt(idilesomRoutes)}`);
  console.log(`\nPotentially new from idilesom: ~${ids.length - parseInt(idilesomPlaces) - parseInt(idilesomRoutes)}`);
  console.log('(run import-idilesom-places.ts --dry-run for exact match with title dedup)\n');

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
