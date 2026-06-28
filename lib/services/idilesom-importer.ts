/**
 * Imports places from idilesom.com/kam/places?district=0 into the `places` table.
 * Deduplicates by name similarity against existing places.
 * If GPS track found — also inserts into `kamchatka_routes`.
 *
 * ~480 places across 24 AJAX pages; uses parallel fetching (20 concurrent).
 */

import { pool } from '@/lib/db-pool';
import { createHash } from 'crypto';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
  'Accept-Language': 'ru-RU,ru;q=0.9',
};

const CONCURRENCY = 20;
const PAGE_DELAY_MS = 300;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── Detect location type from title + description ─────────────────────────────

function detectLocationType(text: string): string {
  const t = text.toLowerCase();
  if (t.match(/вулкан|сопка|кратер/))            return 'volcano';
  if (t.match(/источник|термаль|гейзер|нарзан/)) return 'hot_spring';
  if (t.match(/озеро|лагуна/))                   return 'lake';
  if (t.match(/водопад/))                        return 'waterfall';
  if (t.match(/пляж/))                           return 'beach';
  if (t.match(/бухта/))                          return 'bay';
  if (t.match(/\bмыс\b/))                        return 'cape';
  if (t.match(/река|ручей/))                     return 'river';
  if (t.match(/пещер/))                          return 'cave';
  if (t.match(/перевал|хребет|горн|гора|массив/)) return 'mountain';
  if (t.match(/смотров/))                        return 'viewpoint';
  if (t.match(/остров/))                         return 'island';
  if (t.match(/лес|парк|заповед/))               return 'forest';
  return 'other';
}

// ── Name normalization & similarity ──────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^а-яa-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSimilar(a: string, b: string): boolean {
  const na = normalize(a), nb = normalize(b);
  if (na === nb) return true;
  const wordsA = na.split(' ').filter(w => w.length >= 4);
  const wordsB = new Set(nb.split(' ').filter(w => w.length >= 4));
  const overlap = wordsA.filter(w => wordsB.has(w)).length;
  return overlap >= 2 || (wordsA.length === 1 && wordsB.size === 1 && wordsB.has(wordsA[0]));
}

// ── Fetch all place IDs via AJAX pagination ───────────────────────────────────

async function fetchAllIds(maxPages = 50): Promise<string[]> {
  const all = new Set<string>();

  // First page (plain HTML, no AJAX)
  try {
    const res = await fetch('https://idilesom.com/kam/places?district=0', {
      headers: HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const html = await res.text();
      (html.match(/\/kam\/places\/(\d+)/g) ?? []).forEach(m => all.add(m.split('/').pop()!));
    }
  } catch { /* network hiccup */ }

  // AJAX pages 2…N
  for (let page = 2; page <= maxPages; page++) {
    await sleep(PAGE_DELAY_MS);
    try {
      const res = await fetch(`https://idilesom.com/kam/places?district=0&page=${page}`, {
        headers: { ...HEADERS, 'X-Requested-With': 'XMLHttpRequest' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const data = await res.json() as { empty?: boolean; list?: string };
      if (data.empty) break;
      (data.list?.match(/\/kam\/places\/(\d+)/g) ?? []).forEach(m => all.add(m.split('/').pop()!));
    } catch { continue; }
  }

  return [...all];
}

// ── Scrape individual place page ──────────────────────────────────────────────

interface ScrapedPlace {
  id: string;
  title: string;
  description: string;
  lat: number;
  lng: number;
  locationType: string;
  sourceUrl: string;
  coordinates: number[][];
}

async function scrapePage(id: string): Promise<ScrapedPlace | null> {
  try {
    const res = await fetch(`https://idilesom.com/kam/places/${id}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Title
    const ogTitle = html.match(/property="og:title"\s+content="([^"]+)"/)?.[1]?.trim() ?? '';
    const titleFallback = html.match(/<title>([^<]+)/)?.[1]?.split(' Камчатский')[0]?.trim() ?? '';
    const title = ogTitle || titleFallback;
    if (!title) return null;

    // Description (og:description or first long <p>)
    const ogDesc = html.match(/property="og:description"\s+content="([^"]+)"/)?.[1]?.trim() ?? '';
    const descBlocks = [...html.matchAll(/<p[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/p>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
      .filter(t => t.length > 30);
    const description = descBlocks[0] || ogDesc || '';

    // Coordinates from JSON-LD / meta
    const latM = html.match(/"latitude"\s*:\s*([\d.]+)/);
    const lngM = html.match(/"longitude"\s*:\s*([\d.]+)/);
    let lat = latM ? parseFloat(latM[1]) : null;
    let lng = lngM ? parseFloat(lngM[1]) : null;

    // GPS track — find largest valid coordinate array
    const coordBlocks = html.match(/\[\s*\[\s*[\d.]+\s*,\s*[\d.]+[\s\S]*?\]\s*\]/g) ?? [];
    let coordinates: number[][] = [];
    for (const block of coordBlocks) {
      try {
        const parsed = JSON.parse(block) as unknown;
        if (!Array.isArray(parsed) || parsed.length < 3) continue;
        const first = parsed[0];
        if (!Array.isArray(first)) continue;
        // Determine if [lng, lat] (GeoJSON: |val| > 90 means likely lng) or [lat, lng]
        const isGeoJSON = Math.abs(first[0] as number) > 90;
        const coords: number[][] = isGeoJSON
          ? (parsed as number[][]).map(p => p.length >= 3 ? [p[0], p[1], p[2]] : [p[0], p[1]])
          : (parsed as number[][]).map(p => [p[1], p[0]]);
        if (coords.length > coordinates.length) coordinates = coords;
      } catch { /* skip */ }
    }

    // Derive center from track if no explicit coords
    if ((!lat || !lng) && coordinates.length > 0) {
      const mid = coordinates[Math.floor(coordinates.length / 2)];
      lng = mid[0]; lat = mid[1];
    }

    if (!lat || !lng) return null;
    // Sanity check: Kamchatka bounding box
    if (lat < 50 || lat > 64 || lng < 155 || lng > 167) return null;

    return {
      id,
      title,
      description,
      lat,
      lng,
      locationType: detectLocationType(title + ' ' + description),
      sourceUrl: `https://idilesom.com/kam/places/${id}`,
      coordinates,
    };
  } catch { return null; }
}

// ── Parallel chunk helper ─────────────────────────────────────────────────────

async function runChunked<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  size: number,
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    const settled = await Promise.allSettled(batch.map(fn));
    results.push(...settled);
  }
  return results;
}

// ── Public result types ────────────────────────────────────────────────────────

export interface IdilesomPlaceResult {
  title: string;
  status: 'imported' | 'skipped' | 'error' | 'no_coords';
  type?: string;
  has_track?: boolean;
  error?: string;
}

export interface IdilesomImportResult {
  total: number;
  imported: number;
  skipped: number;
  no_coords: number;
  errors: number;
  duration_ms: number;
  places: IdilesomPlaceResult[];
}

// ── Main import function ──────────────────────────────────────────────────────

export async function importIdilesomPlaces(opts: {
  limit?: number;
  dry_run?: boolean;
} = {}): Promise<IdilesomImportResult> {
  const t0 = Date.now();
  const { limit, dry_run = false } = opts;

  // Load existing place names for dedup
  const { rows: existing } = await pool.query<{ name: string }>(
    `SELECT name FROM places WHERE is_visible = true`,
  );
  const existingNames = existing.map(r => r.name);

  // Fetch all IDs from idilesom
  const allIds = await fetchAllIds(50);
  const ids = limit ? allIds.slice(0, limit) : allIds;

  // Scrape all pages in parallel chunks
  const settled = await runChunked(ids, scrapePage, CONCURRENCY);

  let imported = 0, skipped = 0, no_coords = 0, errors = 0;
  const places: IdilesomPlaceResult[] = [];

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const result = settled[i];

    if (result.status === 'rejected') {
      errors++;
      places.push({ title: `id=${id}`, status: 'error', error: String(result.reason).slice(0, 100) });
      continue;
    }

    const place = result.value;
    if (!place) {
      no_coords++;
      places.push({ title: `id=${id}`, status: 'no_coords' });
      continue;
    }

    // Dedup check
    const dup = existingNames.find(n => isSimilar(n, place.title));
    if (dup) {
      skipped++;
      places.push({ title: place.title, status: 'skipped' });
      continue;
    }

    if (!dry_run) {
      try {
        const arkId = createHash('md5')
          .update(`idilesom-${place.id}`)
          .digest('hex')
          .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');

        await pool.query(
          `INSERT INTO places (
             ark_id, name, description, lat, lng,
             location_type, source_url, source_name, is_visible
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,'idilesom.com',true)
           ON CONFLICT DO NOTHING`,
          [arkId, place.title, place.description || null,
           place.lat, place.lng, place.locationType, place.sourceUrl],
        );

        // If has GPS track — also create kamchatka_routes entry
        if (place.coordinates.length >= 3) {
          const geojson = { type: 'LineString', coordinates: place.coordinates, source: 'idilesom' };
          await pool.query(
            `INSERT INTO kamchatka_routes (
               title, description, lat, lng, geometry,
               source_url, source_name, is_visible, dedupe_key
             ) VALUES ($1,$2,$3,$4,$5,$6,'idilesom.com',true,$7)
             ON CONFLICT (dedupe_key) DO NOTHING`,
            [place.title, place.description || null, place.lat, place.lng,
             JSON.stringify(geojson), place.sourceUrl, `idilesom:${place.id}`],
          );
        }

        existingNames.push(place.title);
      } catch (err) {
        errors++;
        places.push({ title: place.title, status: 'error', error: (err instanceof Error ? err.message : String(err)).slice(0, 100) });
        continue;
      }
    }

    imported++;
    places.push({
      title: place.title,
      status: 'imported',
      type: place.locationType,
      has_track: place.coordinates.length >= 3,
    });
  }

  return {
    total: ids.length,
    imported,
    skipped,
    no_coords,
    errors,
    duration_ms: Date.now() - t0,
    places,
  };
}
