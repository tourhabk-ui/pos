/**
 * scripts/import-idilesom-places.ts
 *
 * Imports new entries from idilesom.com/kam/places with correct classification:
 *
 *   → places           — географический факт (вулкан, озеро, источник, бухта…)
 *   → kamchatka_routes — путь между точками (маршрут, поход, тропа, восхождение)
 *
 * Правило: если в названии/описании есть признаки ПУТИ — это маршрут.
 * Всё остальное — место. GPS-трек у места сохраняется только как geometry
 * для отображения контура, но запись идёт в places, не в kamchatka_routes.
 *
 * Usage:
 *   npx tsx scripts/import-idilesom-places.ts --dry-run
 *   npx tsx scripts/import-idilesom-places.ts
 *   npx tsx scripts/import-idilesom-places.ts --limit 50
 */

import { pool } from '../lib/db-pool';
import { createHash } from 'crypto';

const isDryRun = process.argv.includes('--dry-run');
const limitArg  = process.argv.indexOf('--limit');
const LIMIT     = limitArg !== -1 ? parseInt(process.argv[limitArg + 1]) : 9999;
const DELAY_MS  = 700;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
  'Accept-Language': 'ru-RU,ru;q=0.9',
};

// ─── Classification ───────────────────────────────────────────────────────────

// Returns 'route' if the entry describes a PATH, 'place' if it's a GEOGRAPHIC POINT.
function classify(title: string, desc: string): 'place' | 'route' {
  const t = (title + ' ' + desc).toLowerCase();
  // Strong route signals — words describing movement / paths
  if (t.match(/\bмаршрут\b|\bпоход\b|\bтрек\b|\bтропа\b|\bвосхожден\b|\bпереход\b|\bтраверс\b|\bрадиальн\b|\bпрогулочн.*маршрут\b|\bпуть к\b/)) return 'route';
  // Strong place signals override route signals
  if (t.match(/вулкан|сопка|кратер|кальдер|озеро|лагуна|источник|термаль|гейзер|нарзан|водопад|бухта|мыс|пляж|река\b|ручей|пещер|остров|перевал|хребет|ледник/)) return 'place';
  // If it has a very long track (>50 points) and no clear place keyword — route
  return 'place';
}

function detectLocationType(title: string, desc: string): string {
  const t = (title + ' ' + desc).toLowerCase();
  if (t.match(/вулкан|сопка|кратер|кальдер/)) return 'volcano';
  if (t.match(/гейзер/))                        return 'geyser';
  if (t.match(/источник|термаль|нарзан/))       return 'hot_spring';
  if (t.match(/озеро|лагуна/))                  return 'lake';
  if (t.match(/водопад/))                       return 'waterfall';
  if (t.match(/пляж/))                          return 'beach';
  if (t.match(/бухта/))                         return 'bay';
  if (t.match(/мыс/))                           return 'cape';
  if (t.match(/\bрека\b|ручей/))                return 'river';
  if (t.match(/пещер/))                         return 'cave';
  if (t.match(/перевал/))                       return 'mountain_pass';
  if (t.match(/хребет|горн|гора|массив|ледник/))return 'mountain';
  if (t.match(/смотров/))                       return 'viewpoint';
  if (t.match(/остров/))                        return 'island';
  if (t.match(/лес|парк|заповед/))              return 'forest';
  return 'other';
}

// ─── Fetch all place IDs ──────────────────────────────────────────────────────

async function fetchAllIds(): Promise<string[]> {
  const all = new Set<string>();
  const r1 = await fetch('https://idilesom.com/kam/places', { headers: HEADERS });
  const html = await r1.text();
  (html.match(/\/kam\/places\/(\d+)/g) ?? []).forEach(m => all.add(m.split('/').pop()!));

  for (let page = 2; page <= 30; page++) {
    await sleep(400);
    const res = await fetch(`https://idilesom.com/kam/places?page=${page}`, {
      headers: { ...HEADERS, 'X-Requested-With': 'XMLHttpRequest' },
    });
    const data = await res.json() as { empty?: boolean; list?: string };
    if (data.empty) break;
    (data.list?.match(/\/kam\/places\/(\d+)/g) ?? []).forEach(m => all.add(m.split('/').pop()!));
  }
  return [...all];
}

// ─── Scrape place page ────────────────────────────────────────────────────────

interface IdilesomEntry {
  id: string;
  title: string;
  description: string;
  lat: number;
  lng: number;
  coordinates: number[][];
  sourceUrl: string;
}

async function scrapePage(id: string): Promise<IdilesomEntry | null> {
  const res = await fetch(`https://idilesom.com/kam/places/${id}`, { headers: HEADERS });
  if (!res.ok) return null;
  const html = await res.text();

  const ogTitle    = html.match(/property="og:title"\s+content="([^"]+)"/)?.[1]?.trim() ?? '';
  const titleFall  = html.match(/<title>([^<]+)/)?.[1]?.split(' Камчатский')[0]?.trim() ?? '';
  const title      = ogTitle || titleFall;
  if (!title) return null;

  const ogDesc     = html.match(/property="og:description"\s+content="([^"]+)"/)?.[1]?.trim() ?? '';
  const descBlocks = [...html.matchAll(/<p[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(t => t.length > 30);
  const description = descBlocks[0] || ogDesc || '';

  const latM = html.match(/"latitude"\s*:\s*([\d.]+)/);
  const lngM = html.match(/"longitude"\s*:\s*([\d.]+)/);
  let lat    = latM ? parseFloat(latM[1]) : null;
  let lng    = lngM ? parseFloat(lngM[1]) : null;

  // Extract GPS track
  const coordBlocks = html.match(/\[\s*\[\s*[\d.]+\s*,\s*[\d.]+[\s\S]*?\]\s*\]/g) ?? [];
  let coordinates: number[][] = [];
  for (const block of coordBlocks) {
    try {
      const parsed = JSON.parse(block) as number[][];
      if (!Array.isArray(parsed) || parsed.length < 3 || !Array.isArray(parsed[0])) continue;
      const isGeoJSON = Math.abs(parsed[0][0]) > 90;
      const coords    = isGeoJSON
        ? parsed.map(p => p.length >= 3 ? [p[0], p[1], p[2]] : [p[0], p[1]])
        : parsed.map(p => [p[1], p[0]]);
      if (coords.length > coordinates.length) coordinates = coords;
    } catch { /* skip */ }
  }

  // Fallback coords from track midpoint
  if ((!lat || !lng) && coordinates.length > 0) {
    const mid = coordinates[Math.floor(coordinates.length / 2)];
    lng = mid[0]; lat = mid[1];
  }

  if (!lat || !lng) return null;

  return { id, title, description, lat, lng, coordinates, sourceUrl: `https://idilesom.com/kam/places/${id}` };
}

// ─── Similarity ───────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isSimilar(a: string, b: string): boolean {
  const na = normalize(a), nb = normalize(b);
  if (na === nb) return true;
  const wordsA = na.split(' ').filter(w => w.length >= 4);
  const wordsB = new Set(nb.split(' ').filter(w => w.length >= 4));
  const overlap = wordsA.filter(w => wordsB.has(w)).length;
  return overlap >= 2 || (wordsA.length === 1 && wordsB.has(wordsA[0]));
}

function makeArkId(seed: string): string {
  return createHash('md5').update(seed).digest('hex')
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { rows: existingPlaces } = await pool.query<{ name: string }>(
    `SELECT name FROM places WHERE is_visible = true`,
  );
  const { rows: existingRoutes } = await pool.query<{ title: string }>(
    `SELECT title FROM kamchatka_routes WHERE is_visible = true`,
  );
  const knownPlaces = existingPlaces.map(r => r.name);
  const knownRoutes = existingRoutes.map(r => r.title);
  console.log(`DB: ${knownPlaces.length} places, ${knownRoutes.length} routes`);

  console.log('Fetching idilesom IDs...');
  const allIds = await fetchAllIds();
  const ids    = allIds.slice(0, LIMIT);
  console.log(`idilesom: ${ids.length} entries to check`);
  if (isDryRun) console.log('[DRY RUN — no writes]');

  let newPlaces = 0, newRoutes = 0, skipped = 0, noCoords = 0, errors = 0;

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    process.stdout.write(`[${i + 1}/${ids.length}] `);

    try {
      const entry = await scrapePage(id);
      if (!entry) { process.stdout.write(`no data\n`); noCoords++; await sleep(DELAY_MS); continue; }

      const kind = classify(entry.title, entry.description);

      // Check duplicates against the correct table
      const known = kind === 'route' ? knownRoutes : knownPlaces;
      const dup   = known.find(n => isSimilar(n, entry.title));
      if (dup) {
        process.stdout.write(`skip [${kind}] exists: "${dup.slice(0, 40)}"\n`);
        skipped++;
        await sleep(DELAY_MS);
        continue;
      }

      const pts    = entry.coordinates.length;
      const geojson = pts >= 3
        ? JSON.stringify({ type: 'LineString', coordinates: entry.coordinates, source: 'idilesom' })
        : null;

      if (!isDryRun) {
        if (kind === 'place') {
          const arkId = makeArkId(`idilesom-place-${id}`);
          await pool.query(`
            INSERT INTO places (ark_id, name, description, lat, lng, location_type, source_url, source_name, is_visible)
            VALUES ($1,$2,$3,$4,$5,$6,$7,'idilesom.com',true)
            ON CONFLICT DO NOTHING
          `, [arkId, entry.title, entry.description || null, entry.lat, entry.lng,
              detectLocationType(entry.title, entry.description), entry.sourceUrl]);
          knownPlaces.push(entry.title);
          newPlaces++;
        } else {
          await pool.query(`
            INSERT INTO kamchatka_routes (title, description, lat, lng, geometry, source_url, source_name, is_visible, dedupe_key)
            VALUES ($1,$2,$3,$4,$5,$6,'idilesom.com',true,$7)
            ON CONFLICT (dedupe_key) DO NOTHING
          `, [entry.title, entry.description || null, entry.lat, entry.lng,
              geojson, entry.sourceUrl, `idilesom:${id}`]);
          knownRoutes.push(entry.title);
          newRoutes++;
        }
      } else {
        if (kind === 'place') newPlaces++; else newRoutes++;
      }

      process.stdout.write(
        `NEW [${kind}] "${entry.title.slice(0, 45)}"` +
        (kind === 'place' ? ` [${detectLocationType(entry.title, entry.description)}]` : '') +
        (pts > 0 ? ` +${pts}pts` : '') + '\n',
      );
    } catch (err) {
      process.stdout.write(`ERROR: ${(err as Error).message.slice(0, 60)}\n`);
      errors++;
    }

    await sleep(DELAY_MS);
  }

  console.log(`\nDone: +${newPlaces} places, +${newRoutes} routes, ${skipped} existed, ${noCoords} no coords, ${errors} errors`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
