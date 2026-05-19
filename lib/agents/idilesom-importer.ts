/**
 * lib/agents/idilesom-importer.ts
 *
 * Импортирует новые места и маршруты с idilesom.com/kam/places.
 * Работает через BrightData Web Unlocker (обходит бот-защиту сайта).
 * Вызывается из GET /api/cron/import-routes?source=idilesom
 *
 * Логика классификации:
 *   route  — если в названии/описании есть признаки ПУТИ
 *   place  — всё остальное (вулкан, озеро, источник, бухта…)
 */

import { createHash } from 'crypto';
import { pool } from '@/lib/db-pool';
import { fetchViaBrightData } from '@/lib/scraping/brightdata';

const SOURCE_NAME = 'idilesom.com';
const DELAY_MS    = 700;

export interface ImportResult {
  inserted_places: number;
  inserted_routes: number;
  skipped: number;
  no_coords: number;
  errors: number;
  duration_ms: number;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─── Classification ───────────────────────────────────────────────────────────

function classify(title: string, desc: string): 'place' | 'route' {
  const t = (title + ' ' + desc).toLowerCase();
  if (/\bмаршрут\b|\bпоход\b|\bтрек\b|\bтропа\b|\bвосхожден|\bпереход\b|\bтраверс\b|\bрадиальн|\bпуть к\b/.test(t))
    return 'route';
  if (/вулкан|сопка|кратер|кальдер|озеро|лагуна|источник|термаль|гейзер|нарзан|водопад|бухта|мыс|пляж|\bрека\b|ручей|пещер|остров|перевал|хребет|ледник/.test(t))
    return 'place';
  return 'place';
}

function detectLocationType(title: string, desc: string): string {
  const t = (title + ' ' + desc).toLowerCase();
  if (/вулкан|сопка|кратер|кальдер/.test(t)) return 'volcano';
  if (/гейзер/.test(t))                       return 'geyser';
  if (/источник|термаль|нарзан/.test(t))      return 'hot_spring';
  if (/озеро|лагуна/.test(t))                 return 'lake';
  if (/водопад/.test(t))                      return 'waterfall';
  if (/пляж/.test(t))                         return 'beach';
  if (/бухта/.test(t))                        return 'bay';
  if (/мыс/.test(t))                          return 'cape';
  if (/\bрека\b|ручей/.test(t))               return 'river';
  if (/пещер/.test(t))                        return 'cave';
  if (/перевал/.test(t))                      return 'mountain_pass';
  if (/хребет|горн|гора|массив|ледник/.test(t)) return 'mountain';
  if (/остров/.test(t))                       return 'island';
  return 'other';
}

function makeArkId(seed: string): string {
  return createHash('md5').update(seed).digest('hex')
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}

// ─── Title similarity ─────────────────────────────────────────────────────────

function normalize(s: string) {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function isSimilar(a: string, b: string): boolean {
  const na = normalize(a), nb = normalize(b);
  if (na === nb) return true;
  const wa = na.split(' ').filter(w => w.length >= 4);
  const wb = new Set(nb.split(' ').filter(w => w.length >= 4));
  const overlap = wa.filter(w => wb.has(w)).length;
  return overlap >= 2 || (wa.length === 1 && wb.has(wa[0]));
}

// ─── Fetch all IDs from listing ───────────────────────────────────────────────

async function fetchAllIds(batch: number): Promise<string[]> {
  const seen = new Set<string>();

  const html = await fetchViaBrightData('https://idilesom.com/kam/places', { zone: 'unlocker', country: 'ru' });
  if (!html) throw new Error('BrightData unavailable or token missing');
  (html.match(/\/kam\/places\/(\d+)/g) ?? []).forEach(m => seen.add(m.split('/').pop()!));

  for (let page = 2; page <= 99; page++) {
    await sleep(400);
    const raw = await fetchViaBrightData(
      `https://idilesom.com/kam/places?page=${page}`,
      { zone: 'unlocker', country: 'ru', timeoutMs: 20_000 }
    );
    if (!raw) break;
    let data: { empty?: boolean; list?: string } = {};
    try { data = JSON.parse(raw); } catch { /* HTML fallback */ }
    if (data.empty) break;
    const source = data.list ?? raw;
    (source.match(/\/kam\/places\/(\d+)/g) ?? []).forEach(m => seen.add(m.split('/').pop()!));
    if (seen.size >= batch) break;
  }

  return [...seen].slice(0, batch);
}

// ─── Parse one place page ─────────────────────────────────────────────────────

interface Entry {
  id: string;
  title: string;
  description: string;
  lat: number;
  lng: number;
  coordinates: number[][];
  sourceUrl: string;
}

async function scrapePage(id: string): Promise<Entry | null> {
  const html = await fetchViaBrightData(
    `https://idilesom.com/kam/places/${id}`,
    { zone: 'unlocker', country: 'ru', timeoutMs: 25_000 }
  );
  if (!html) return null;

  const ogTitle   = html.match(/property="og:title"\s+content="([^"]+)"/)?.[1]?.trim() ?? '';
  const titleFall = html.match(/<title>([^<]+)/)?.[1]?.split(' Камчатск')[0]?.trim() ?? '';
  const title = (ogTitle || titleFall).replace(/\s*[-—]\s*ИдиЛесом.*/i, '').trim();
  if (!title) return null;

  const ogDesc     = html.match(/property="og:description"\s+content="([^"]+)"/)?.[1]?.trim() ?? '';
  const descBlocks = [...html.matchAll(/<p[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(t => t.length > 30);
  const description = descBlocks[0] || ogDesc || '';

  const latM = html.match(/"latitude"\s*:\s*([\d.]+)/);
  const lngM = html.match(/"longitude"\s*:\s*([\d.]+)/);
  let lat = latM ? parseFloat(latM[1]) : null;
  let lng = lngM ? parseFloat(lngM[1]) : null;

  let coordinates: number[][] = [];
  const coordBlocks = html.match(/\[\s*\[\s*[\d.]+\s*,\s*[\d.]+[\s\S]*?\]\s*\]/g) ?? [];
  for (const block of coordBlocks) {
    try {
      const parsed = JSON.parse(block) as number[][];
      if (!Array.isArray(parsed) || parsed.length < 3 || !Array.isArray(parsed[0])) continue;
      const isGeoJSON = Math.abs(parsed[0][0]) > 90;
      const coords = isGeoJSON
        ? parsed.map(p => p.length >= 3 ? [p[0], p[1], p[2]] : [p[0], p[1]])
        : parsed.map(p => [p[1], p[0]]);
      if (coords.length > coordinates.length) coordinates = coords;
    } catch { /* skip */ }
  }

  if ((!lat || !lng) && coordinates.length > 0) {
    const mid = coordinates[Math.floor(coordinates.length / 2)];
    lng = mid[0]; lat = mid[1];
  }
  if (!lat || !lng) return null;

  return { id, title, description, lat, lng, coordinates, sourceUrl: `https://idilesom.com/kam/places/${id}` };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function runIdilesomImporter(batch = 30): Promise<ImportResult> {
  const started = Date.now();
  const result: ImportResult = { inserted_places: 0, inserted_routes: 0, skipped: 0, no_coords: 0, errors: 0, duration_ms: 0 };

  const [{ rows: existingPlaces }, { rows: existingRoutes }] = await Promise.all([
    pool.query<{ name: string }>(`SELECT name FROM places WHERE is_visible = true`),
    pool.query<{ title: string }>(`SELECT title FROM kamchatka_routes WHERE is_visible = true`),
  ]);
  const knownPlaces = existingPlaces.map(r => r.name);
  const knownRoutes = existingRoutes.map(r => r.title);

  let ids: string[];
  try {
    ids = await fetchAllIds(batch * 3); // fetch more than needed to account for dups/no-coords
  } catch (e) {
    result.errors++;
    result.duration_ms = Date.now() - started;
    return result;
  }

  let processed = 0;
  for (const id of ids) {
    if (processed >= batch) break;

    try {
      await sleep(DELAY_MS);
      const entry = await scrapePage(id);
      if (!entry) { result.no_coords++; continue; }

      const kind = classify(entry.title, entry.description);
      const known = kind === 'route' ? knownRoutes : knownPlaces;
      if (known.find(n => isSimilar(n, entry.title))) { result.skipped++; continue; }

      const geojson = entry.coordinates.length >= 3
        ? JSON.stringify({ type: 'LineString', coordinates: entry.coordinates, source: 'idilesom' })
        : null;

      if (kind === 'place') {
        const arkId = makeArkId(`idilesom-place-${id}`);
        await pool.query(`
          INSERT INTO places (ark_id, name, description, lat, lng, location_type, source_url, source_name, is_visible)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
          ON CONFLICT DO NOTHING
        `, [arkId, entry.title, entry.description || null, entry.lat, entry.lng,
            detectLocationType(entry.title, entry.description), entry.sourceUrl, SOURCE_NAME]);
        knownPlaces.push(entry.title);
        result.inserted_places++;
      } else {
        await pool.query(`
          INSERT INTO kamchatka_routes (title, description, lat, lng, geometry, source_url, source_name, is_visible, dedupe_key)
          VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8)
          ON CONFLICT (dedupe_key) DO NOTHING
        `, [entry.title, entry.description || null, entry.lat, entry.lng,
            geojson, entry.sourceUrl, SOURCE_NAME, `idilesom:${id}`]);
        knownRoutes.push(entry.title);
        result.inserted_routes++;
      }

      processed++;
    } catch {
      result.errors++;
    }
  }

  result.duration_ms = Date.now() - started;
  return result;
}
