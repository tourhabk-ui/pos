/**
 * Imports geographic places from idilesom.com/kam/places?district=0.
 *
 * idilesom "places" = geographic destinations (volcano, lake, spring…)
 * with an optional GPS hiking track to reach them.
 *
 * Mapping:
 *   places          ← geographic point (name, coords, type, description)
 *   kamchatka_routes ← GPS track of the hike, if present (≥3 waypoints)
 *   operator_tours  ← NEVER (idilesom has no prices or booking)
 *
 * Three-layer deduplication:
 *   1. source_url exact match  — already imported this idilesom id
 *   2. coordinate proximity    — within 500 m of existing place of any type
 *   3. name similarity         — geo-prefix-stripped word overlap ≥ 2
 */

import { pool } from '@/lib/db-pool';
import { createHash } from 'crypto';
import { fetchViaBrightData } from '@/lib/scraping/brightdata';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0',
  'Accept-Language': 'ru-RU,ru;q=0.9',
};

const CONCURRENCY = 20;
const PAGE_DELAY_MS = 300;

// ── Geo type detection ────────────────────────────────────────────────────────

const GEO_TYPE_RULES: Array<{ re: RegExp; type: string }> = [
  { re: /вулкан|сопк|кратер/,              type: 'volcano'   },
  { re: /источник|термал|гейзер|нарзан/,   type: 'hot_spring'},
  { re: /озеро|лагун/,                     type: 'lake'      },
  { re: /водопад/,                          type: 'waterfall' },
  { re: /пляж/,                             type: 'beach'     },
  { re: /бухт/,                             type: 'bay'       },
  { re: /\bмыс\b/,                          type: 'cape'      },
  { re: /\bрека\b|\bручей\b/,              type: 'river'     },
  { re: /пещер/,                            type: 'cave'      },
  { re: /перевал|хребет|горн|гора|массив|бат|скал/, type: 'mountain' },
  { re: /смотров/,                          type: 'viewpoint' },
  { re: /остров/,                           type: 'island'    },
  { re: /долин|лес|парк|заповед|поле/,     type: 'forest'    },
  { re: /мыс|коса/,                         type: 'cape'      },
  { re: /каньон|ущель/,                     type: 'mountain'  },
];

function detectLocationType(text: string): string | null {
  const t = text.toLowerCase();
  for (const { re, type } of GEO_TYPE_RULES) {
    if (re.test(t)) return type;
  }
  return null;
}

// ── Article / non-geographic filter ──────────────────────────────────────────
// idilesom mixes geographic places with travel articles in the same list.
// Articles have no geographic type and read like sentences/phrases.

const ARTICLE_STARTS = /^(пока |когда |как |где |что |зачем |почему |лучш|топ |топ-|интересн|секрет|совет|история|всё что|для тех кто|маршрут на|поход на|подъём|путеводит)/i;

function isArticleOrCommercial(title: string, locationType: string | null): boolean {
  if (locationType !== null) return false;     // has a recognized geo type → keep
  if (ARTICLE_STARTS.test(title)) return true; // looks like an article headline
  // Generic multi-word title with no geo type and no recognizable proper noun pattern
  const words = title.split(/\s+/);
  // Proper geographic name: usually 1-4 words, each word starts with capital
  const allCapitalized = words.every(w => /^[А-ЯA-Z]/.test(w));
  return !allCapitalized;                       // lower-case words → article
}

// ── Haversine distance (km) ───────────────────────────────────────────────────

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Name normalization & similarity ──────────────────────────────────────────
// Remove geographic prefixes before comparing so:
//   "Вулкан Авача" == "Авачинский вулкан" gets higher word overlap.

const GEO_PREFIXES = /^(вулкан|гора|озеро|река|мыс|бухта|хребет|перевал|остров|долина|источник|водопад|пляж|ручей|пещера|ущелье)\s+/gi;

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(GEO_PREFIXES, '')
    .replace(/[^а-яa-z0-9\s-]/g, ' ')
    .replace(/[-\s]+/g, ' ')
    .trim();
}

function nameSimilarity(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na === nb) return true;
  // Short exact containment: "Авача" inside "Авачинский" or vice-versa
  if (na.length >= 5 && nb.startsWith(na.slice(0, 5))) return true;
  if (nb.length >= 5 && na.startsWith(nb.slice(0, 5))) return true;
  // Word overlap: ≥2 meaningful words in common
  const wordsA = na.split(' ').filter(w => w.length >= 4);
  const wordsB = new Set(nb.split(' ').filter(w => w.length >= 4));
  const overlap = wordsA.filter(w => wordsB.has(w)).length;
  return overlap >= 2 || (wordsA.length === 1 && wordsB.size === 1 && wordsB.has(wordsA[0]));
}

// ── Fetch с фоллбэком на BrightData Web Unlocker ─────────────────────────────
//
// idilesom.com включил бот-защиту (прямые запросы получают 403 и с прода, и
// с внешних фетчеров). Паттерн ровно как у импорта паспортов visitkamchatka:
// прямой fetch → при отказе BrightData Web Unlocker (BRIGHTDATA_API_TOKEN,
// lib/scraping/brightdata.ts). Без токена фоллбэк недоступен — это честно
// попадает в listingErrors.

type FetchedText = { text: string } | { text: null; error: string };

async function fetchTextWithFallback(url: string, ajax = false): Promise<FetchedText> {
  let directError: string;
  try {
    const res = await fetch(url, {
      headers: ajax ? { ...HEADERS, 'X-Requested-With': 'XMLHttpRequest' } : HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { text: await res.text() };
    directError = `HTTP ${res.status}`;
  } catch (err) {
    directError = err instanceof Error ? err.message : String(err);
  }

  const viaBd = await fetchViaBrightData(url);
  if (viaBd) return { text: viaBd };

  const bdNote = process.env.BRIGHTDATA_API_TOKEN
    ? 'BrightData-фоллбэк тоже не пробился'
    : 'BRIGHTDATA_API_TOKEN не задан — фоллбэк Web Unlocker недоступен';
  return { text: null, error: `${directError} (${bdNote})` };
}

/** Ссылки /kam/places/N из HTML или JSON-тела (в JSON слэши экранированы как \/). */
function extractPlaceIds(body: string): string[] {
  const normalized = body.replace(/\\\//g, '/');
  return [...normalized.matchAll(/\/kam\/places\/(\d+)/g)].map((m) => m[1]);
}

// ── Fetch all place IDs via AJAX pagination ───────────────────────────────────
//
// Ошибки листинга НЕ глотаются: раньше недоступный сайт (бот-защита, 403,
// таймаут) выглядел как «0 страниц, 0 ошибок» — тихий сбой, который владелец
// принимал за пустой источник. Теперь причины возвращаются в отчёт.

export interface IdilesomListing {
  ids: string[];
  listingErrors: string[];
}

export async function fetchAllIds(maxPages = 50, targetIds = Infinity): Promise<IdilesomListing> {
  const all = new Set<string>();
  const listingErrors: string[] = [];

  // First page (plain HTML)
  const first = await fetchTextWithFallback('https://idilesom.com/kam/places?district=0');
  if (first.text !== null) {
    for (const id of extractPlaceIds(first.text)) all.add(id);
    if (all.size === 0) {
      listingErrors.push('Страница листинга загрузилась, но ссылок /kam/places/N в ней нет — вёрстка изменилась?');
    }
  } else {
    listingErrors.push(`Страница листинга: ${first.error}`);
  }

  // AJAX pages 2…N — отказы считаем и репортим сводкой, не по одному.
  // Через BrightData ответ может прийти полной HTML-страницей (без флага
  // empty), поэтому дополнительный стоп: две страницы подряд без новых id.
  // targetIds: при лимите импорта не тянем все 50 страниц (через BrightData
  // это минуты и деньги) — останавливаемся, как только id хватает. Иначе
  // даже limit=10 упирался в полный обход листинга и рвал запрос по таймауту.
  let ajaxFailures = 0;
  let firstAjaxError: string | null = null;
  let pagesWithoutNewIds = 0;
  for (let page = 2; page <= maxPages; page++) {
    if (all.size >= targetIds) break;
    await new Promise(r => setTimeout(r, PAGE_DELAY_MS));
    const res = await fetchTextWithFallback(`https://idilesom.com/kam/places?district=0&page=${page}`, true);
    if (res.text === null) {
      ajaxFailures++;
      firstAjaxError ??= res.error;
      continue;
    }
    try {
      const data = JSON.parse(res.text) as { empty?: boolean };
      if (data.empty) break;
    } catch { /* не-JSON (HTML через BrightData) — парсим ссылки как есть */ }
    const before = all.size;
    for (const id of extractPlaceIds(res.text)) all.add(id);
    if (all.size === before) {
      pagesWithoutNewIds++;
      if (pagesWithoutNewIds >= 2) break;
    } else {
      pagesWithoutNewIds = 0;
    }
  }
  if (ajaxFailures > 0) {
    listingErrors.push(`AJAX-пагинация: ${ajaxFailures} страниц не загрузились (первая ошибка: ${firstAjaxError})`);
  }

  return { ids: [...all], listingErrors };
}

// ── Scrape individual place page ──────────────────────────────────────────────

interface ScrapedPlace {
  id: string;
  title: string;
  description: string;
  lat: number;
  lng: number;
  locationType: string;       // geo type (volcano, lake…) or 'other'
  sourceUrl: string;
  coordinates: number[][];    // GPS track waypoints [lng, lat, ele?]
}

async function scrapePage(id: string): Promise<ScrapedPlace | null> {
  try {
    const fetched = await fetchTextWithFallback(`https://idilesom.com/kam/places/${id}`);
    if (fetched.text === null) return null;
    const html = fetched.text;

    // Title
    const ogTitle = html.match(/property="og:title"\s+content="([^"]+)"/)?.[1]?.trim() ?? '';
    const titleFallback = html.match(/<title>([^<]+)/)?.[1]?.split(' Камчатский')[0]?.trim() ?? '';
    const title = ogTitle || titleFallback;
    if (!title || title.length < 3) return null;

    // Description
    const ogDesc = html.match(/property="og:description"\s+content="([^"]+)"/)?.[1]?.trim() ?? '';
    const descMatch = [...html.matchAll(/<p[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/p>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
      .find(t => t.length > 30);
    const description = descMatch || ogDesc || '';

    // Check: is this an article/non-geographic entry?
    const locationType = detectLocationType(title + ' ' + description) ?? 'other';
    const geoType = locationType !== 'other' ? locationType : null;
    if (isArticleOrCommercial(title, geoType)) return null;

    // Coordinates (explicit JSON-LD)
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
        if (!Array.isArray(first) || first.length < 2) continue;
        // GeoJSON = [lng, lat, ele?] — lng is usually > 90 at Kamchatka (155-167)
        const isGeoJSON = Math.abs(first[0] as number) > 90;
        const coords: number[][] = isGeoJSON
          ? (parsed as number[][]).map(p => p.length >= 3 ? [p[0], p[1], p[2]] : [p[0], p[1]])
          : (parsed as number[][]).map(p => [p[1], p[0]]);
        if (coords.length > coordinates.length) coordinates = coords;
      } catch { /* skip */ }
    }

    // Derive center from track midpoint if no explicit JSON-LD coords
    if ((!lat || !lng) && coordinates.length > 0) {
      const mid = coordinates[Math.floor(coordinates.length / 2)];
      lng = mid[0]; lat = mid[1];
    }

    if (!lat || !lng) return null;

    // Kamchatka bounding box: 50–64°N, 155–167°E
    if (lat < 50 || lat > 64 || lng < 155 || lng > 167) return null;

    return {
      id,
      title,
      description,
      lat,
      lng,
      locationType,
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
    const settled = await Promise.allSettled(items.slice(i, i + size).map(fn));
    results.push(...settled);
  }
  return results;
}

// ── Public result types ────────────────────────────────────────────────────────

export interface IdilesomPlaceResult {
  title: string;
  status: 'imported' | 'skipped' | 'filtered' | 'error' | 'no_coords';
  type?: string;
  has_track?: boolean;
  skip_reason?: string;
  error?: string;
}

export interface IdilesomImportResult {
  total: number;
  imported: number;
  skipped: number;
  filtered: number;
  no_coords: number;
  errors: number;
  duration_ms: number;
  places: IdilesomPlaceResult[];
  /** Ошибки загрузки самого листинга (бот-защита/403/таймаут) — иначе они выглядели как «0 страниц». */
  listing_errors: string[];
}

// ── Main import function ──────────────────────────────────────────────────────

export async function importIdilesomPlaces(opts: {
  limit?: number;
  dry_run?: boolean;
} = {}): Promise<IdilesomImportResult> {
  const t0 = Date.now();
  const { limit, dry_run = false } = opts;

  // Load existing places for dedup (names + coordinates + source URLs)
  const { rows: existing } = await pool.query<{
    name: string;
    lat: number | null;
    lng: number | null;
    source_url: string | null;
  }>(
    `SELECT name, lat, lng, source_url FROM places WHERE is_visible = true`,
  );

  // Also load idilesom source URLs already in DB (layer 1 dedup)
  const importedUrls = new Set(
    existing
      .filter(r => r.source_url?.includes('idilesom'))
      .map(r => r.source_url!),
  );

  // Places with coordinates for proximity dedup (layer 2)
  const existingWithCoords = existing.filter(r => r.lat && r.lng) as Array<{
    name: string; lat: number; lng: number;
  }>;

  // Names for name-similarity dedup (layer 3)
  const existingNames = existing.map(r => r.name);

  // Fetch IDs from idilesom. При лимите не тянем все 50 страниц листинга
  // (через BrightData это минуты и деньги, плюс браузерный запрос рвётся по
  // таймауту) — берём с запасом ×3 на отсев дублей/статей.
  const targetIds = limit ? limit * 3 : Infinity;
  const { ids: allIds, listingErrors } = await fetchAllIds(50, targetIds);
  const ids = limit ? allIds.slice(0, limit) : allIds;

  // Scrape all pages in parallel chunks
  const settled = await runChunked(ids, scrapePage, CONCURRENCY);

  let imported = 0, skipped = 0, filtered = 0, no_coords = 0, errors = 0;
  const places: IdilesomPlaceResult[] = [];

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const result = settled[i];

    if (result.status === 'rejected') {
      errors++;
      places.push({ title: `id=${id}`, status: 'error', error: String(result.reason).slice(0, 100) });
      continue;
    }

    // scrapePage returned null = no coords or filtered as article
    if (!result.value) {
      no_coords++;
      places.push({ title: `id=${id}`, status: 'no_coords' });
      continue;
    }

    const place = result.value;

    // Layer 0: article/commercial already filtered in scrapePage (returns null)
    // But note it for reporting
    const geoType = place.locationType !== 'other' ? place.locationType : null;
    if (isArticleOrCommercial(place.title, geoType)) {
      filtered++;
      places.push({ title: place.title, status: 'filtered', skip_reason: 'article_or_commercial' });
      continue;
    }

    // Layer 1: source URL exact match
    if (importedUrls.has(place.sourceUrl)) {
      skipped++;
      places.push({ title: place.title, status: 'skipped', skip_reason: 'url_exists' });
      continue;
    }

    // Layer 2: coordinate proximity (≤500m from an existing place)
    const PROXIMITY_KM = 0.5;
    const nearDuplicate = existingWithCoords.find(
      ex => haversineKm(ex.lat, ex.lng, place.lat, place.lng) <= PROXIMITY_KM,
    );
    if (nearDuplicate) {
      skipped++;
      places.push({
        title: place.title,
        status: 'skipped',
        skip_reason: `coord_proximity: "${nearDuplicate.name}"`,
      });
      continue;
    }

    // Layer 3: name similarity
    const nameDup = existingNames.find(n => nameSimilarity(n, place.title));
    if (nameDup) {
      skipped++;
      places.push({
        title: place.title,
        status: 'skipped',
        skip_reason: `name_match: "${nameDup.slice(0, 50)}"`,
      });
      continue;
    }

    // All dedup layers passed → insert
    if (!dry_run) {
      try {
        const arkId = createHash('md5')
          .update(`idilesom-${place.id}`)
          .digest('hex')
          .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');

        // Insert into places (geographic point)
        await pool.query(
          `INSERT INTO places (
             ark_id, name, description, lat, lng,
             location_type, source_url, source_name, is_visible
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,'idilesom.com',true)
           ON CONFLICT DO NOTHING`,
          [arkId, place.title, place.description || null,
           place.lat, place.lng, place.locationType, place.sourceUrl],
        );

        // Insert GPS track into kamchatka_routes (the hiking route to this place)
        if (place.coordinates.length >= 3) {
          const geojson = JSON.stringify({
            type: 'LineString',
            coordinates: place.coordinates,
            source: 'idilesom',
          });
          await pool.query(
            `INSERT INTO kamchatka_routes (
               category, title, description, lat, lng, geometry,
               source_url, source_name, is_visible, dedupe_key
             ) VALUES ('trekking',$1,$2,$3,$4,$5,$6,'idilesom.com',true,$7)
             ON CONFLICT (dedupe_key) DO NOTHING`,
            [place.title, place.description || null, place.lat, place.lng,
             geojson, place.sourceUrl, `idilesom:${place.id}`],
          );
        }

        importedUrls.add(place.sourceUrl);
        existingNames.push(place.title);
        existingWithCoords.push({ name: place.title, lat: place.lat, lng: place.lng });
      } catch (err) {
        errors++;
        places.push({
          title: place.title,
          status: 'error',
          error: (err instanceof Error ? err.message : String(err)).slice(0, 100),
        });
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
    filtered,
    no_coords,
    errors,
    duration_ms: Date.now() - t0,
    places,
    listing_errors: listingErrors,
  };
}

// ── Track backfill ────────────────────────────────────────────────────────────
// Первичный импорт клал GPS-трек только для НОВЫХ мест: задедупленные
// (существующие в БД из других источников) оставались без трека, хотя на
// idilesom он есть (кейс владельца: «Гора Замок»). Backfill обходит ЛИСТИНГ
// idilesom (а не только idilesom-помеченные места!), скрейпит страницы,
// матчит к нашим местам по близости+имени (та же логика, что dedupe) и
// пишет трек в kamchatka_routes с ссылкой metadata.place_ark_id — по ней
// GPX-экспорт точки находит её маршрут.

export interface IdilesomTrackBackfillResult {
  listing_total: number;
  offset: number;
  processed: number;
  tracks_written: number;
  matched_places: number;
  no_track: number;
  skipped_existing: number;
  errors: number;
  has_more: boolean;
  listing_errors: string[];
  duration_ms: number;
  items: Array<{ idilesom_id: string; title?: string; status: string; place?: string; points?: number }>;
}

export async function backfillIdilesomTracks(limit = 10, offset = 0): Promise<IdilesomTrackBackfillResult> {
  const t0 = Date.now();

  // targetIds — ранний стоп листинга: не тянем все страницы ради одной партии
  const listing = await fetchAllIds(50, offset + limit + 1);
  const batchIds = listing.ids.slice(offset, offset + limit);
  const hasMore = listing.ids.length > offset + limit;

  const items: IdilesomTrackBackfillResult['items'] = [];
  let tracksWritten = 0;
  let matchedPlaces = 0;
  let noTrack = 0;
  let skippedExisting = 0;
  let errors = 0;

  // Уже готовые треки этой партии — не скрейпим повторно
  const keys = batchIds.map(id => `idilesom:${id}`);
  const { rows: doneRows } = await pool.query<{ dedupe_key: string }>(
    `SELECT dedupe_key FROM kamchatka_routes
     WHERE dedupe_key = ANY($1) AND geometry IS NOT NULL`,
    [keys],
  );
  const done = new Set(doneRows.map(r => r.dedupe_key));
  const todo = batchIds.filter(id => !done.has(`idilesom:${id}`));
  skippedExisting = batchIds.length - todo.length;

  const settled = await runChunked(todo, async (id) => ({ id, scraped: await scrapePage(id) }), 5);

  for (const s of settled) {
    if (s.status === 'rejected') {
      errors++;
      items.push({ idilesom_id: 'unknown', status: `error: ${String(s.reason).slice(0, 120)}` });
      continue;
    }
    const { id, scraped } = s.value;
    if (!scraped) {
      noTrack++;
      items.push({ idilesom_id: id, status: 'no_page' });
      continue;
    }
    if (scraped.coordinates.length < 3) {
      noTrack++;
      items.push({ idilesom_id: id, title: scraped.title, status: 'no_track' });
      continue;
    }

    try {
      // Матчим к НАШЕМУ месту: близость ≤ 700 м + похожее имя (логика dedupe)
      const { rows: nearby } = await pool.query<{ ark_id: string; name: string; lat: number; lng: number }>(
        `SELECT ark_id, name, lat, lng FROM places
         WHERE is_visible = true
           AND lat BETWEEN $1 - 0.01 AND $1 + 0.01
           AND lng BETWEEN $2 - 0.02 AND $2 + 0.02`,
        [scraped.lat, scraped.lng],
      );
      const match = nearby.find(pl =>
        haversineKm(pl.lat, pl.lng, scraped.lat, scraped.lng) <= 0.7 &&
        nameSimilarity(pl.name, scraped.title),
      ) ?? nearby.find(pl => nameSimilarity(pl.name, scraped.title)) ?? null;

      const metadata = JSON.stringify(match ? { place_ark_id: match.ark_id } : {});
      const geojson = JSON.stringify({
        type: 'LineString',
        coordinates: scraped.coordinates,
        source: 'idilesom',
      });

      // UPSERT по dedupe_key: обновляем geometry, только если её нет или
      // прежний трек тоже idilesom (OSM-треки не перетираем)
      await pool.query(
        `INSERT INTO kamchatka_routes (
           category, title, description, lat, lng, geometry, metadata,
           source_url, source_name, is_visible, dedupe_key
         ) VALUES ('trekking',$1,$2,$3,$4,$5,$6::jsonb,$7,'idilesom.com',true,$8)
         ON CONFLICT (dedupe_key) DO UPDATE
           SET geometry = EXCLUDED.geometry,
               metadata = COALESCE(kamchatka_routes.metadata, '{}'::jsonb) || EXCLUDED.metadata
           WHERE kamchatka_routes.geometry IS NULL
              OR kamchatka_routes.geometry->>'source' = 'idilesom'`,
        [scraped.title, scraped.description || null, scraped.lat, scraped.lng,
         geojson, metadata, scraped.sourceUrl, `idilesom:${id}`],
      );

      tracksWritten++;
      if (match) matchedPlaces++;
      items.push({
        idilesom_id: id,
        title: scraped.title,
        status: 'track_written',
        place: match?.name,
        points: scraped.coordinates.length,
      });
    } catch (err) {
      errors++;
      items.push({
        idilesom_id: id,
        title: scraped.title,
        status: `error: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`,
      });
    }
  }

  return {
    listing_total: listing.ids.length,
    offset,
    processed: todo.length,
    tracks_written: tracksWritten,
    matched_places: matchedPlaces,
    no_track: noTrack,
    skipped_existing: skippedExisting,
    errors,
    has_more: hasMore,
    listing_errors: listing.listingErrors,
    duration_ms: Date.now() - t0,
    items,
  };
}
