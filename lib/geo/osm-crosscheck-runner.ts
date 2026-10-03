/**
 * Раннер массовой сверки places с OpenStreetMap — сеть (Overpass) + БД.
 *
 * Чистая логика (сборка кандидатов) — в lib/geo/osm-crosscheck.ts. Здесь
 * только IO: один bulk-запрос к Overpass, выборка живых places, батч
 * pg_trgm-сравнения имён одним SQL-запросом. НИ ОДНОГО write-запроса —
 * ни UPDATE, ни INSERT, ни DELETE, ни при каком аргументе: инструмент
 * только показывает кандидатов, решение и правку делает человек через
 * POST /api/cron/place-coords (с источником) или отдельную миграцию
 * (скрытие без источника) — как уже было сделано 10.09 для Голубых озёр,
 * Овального и Лежбища сивучей.
 */

import { pool } from '@/lib/db-pool';
import { KAMCHATKA_BOUNDS } from '@/lib/services/routes/geocode';
import {
  buildOsmCrosscheckQuery, parseOsmFeatures, buildCrosscheckItems, splitBounds,
  type GeoBounds, type OsmFeature, type PlaceInput, type SimilarityRow, type CrosscheckResult,
} from '@/lib/geo/osm-crosscheck';

// Тот же двухзеркальный фолбэк, что у импорта геометрии маршрутов
// (lib/import/osm-import-runner.ts) — primary отвечает 406 без осмысленного
// User-Agent, поэтому шлём идентифицирующие заголовки и переключаемся на
// зеркало Kumi Systems при не-2xx.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OSM_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'Accept': 'application/json',
  'User-Agent': 'KamchatourHub-OSM-Crosscheck/1.0 (+https://vedarai.ru)',
};

/** На один квадрат края (splitBounds); серверный таймаут запроса — меньше. */
const OVERPASS_TIMEOUT_MS = 45_000;
const OVERPASS_QUERY_TIMEOUT_S = 40;
/** Пауза между квадратами: у публичного Overpass два слота на адрес. */
const TILE_PAUSE_MS = 1_000;

/**
 * Один квадрат: оба сервера по очереди. Отказ — со ВСЕМИ причинами: прежде
 * печаталась только последняя (504 зеркала), а причина отказа основного
 * сервера терялась.
 */
async function fetchTile(tile: GeoBounds): Promise<OsmFeature[]> {
  const body = `data=${encodeURIComponent(buildOsmCrosscheckQuery(tile, OVERPASS_QUERY_TIMEOUT_S))}`;
  const errors: string[] = [];
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const host = new URL(endpoint).host;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: OSM_HEADERS,
        body,
        signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
      });
      if (!res.ok) { errors.push(`${host}: HTTP ${res.status}`); continue; }
      const data = (await res.json()) as { remark?: string };
      // Overpass отвечает 200 и при собственном таймауте — с remark и пустым
      // списком. Пустота здесь — «не смог», а не «объектов нет».
      if (typeof data.remark === 'string' && /error|timed out/i.test(data.remark)) {
        errors.push(`${host}: ${data.remark.slice(0, 120)}`);
        continue;
      }
      return parseOsmFeatures(data);
    } catch (err) {
      errors.push(`${host}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const box = `${tile.latMin}–${tile.latMax}° × ${tile.lngMin}–${tile.lngMax}°`;
  throw new Error(`Overpass, квадрат ${box}: ${errors.join('; ')}`);
}

/**
 * Все именованные объекты края — квадратами (splitBounds). Хоть один
 * квадрат не прочитан — отказ целиком с его именем: неполный список выглядел
 * бы как «в этом районе расхождений нет» (§4.0).
 */
export async function fetchOsmFeatures(
  bounds: GeoBounds = KAMCHATKA_BOUNDS,
  opts: { tilePauseMs?: number } = {},
): Promise<OsmFeature[]> {
  const pauseMs = opts.tilePauseMs ?? TILE_PAUSE_MS;
  const byKey = new Map<string, OsmFeature>();
  const tiles = splitBounds(bounds);
  for (let i = 0; i < tiles.length; i += 1) {
    if (i > 0 && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    // Объект на границе квадратов приходит дважды — склеиваем по роду и id.
    for (const f of await fetchTile(tiles[i])) byKey.set(`${f.kind}:${f.id}`, f);
  }
  return [...byKey.values()];
}

export interface OsmCrosscheckParams {
  minSim: number;
  /** Пауза между квадратами Overpass; в тестах — 0. */
  tilePauseMs?: number;
  bounds?: typeof KAMCHATKA_BOUNDS;
}

export interface OsmCrosscheckRunResult extends CrosscheckResult {
  checkedPlacesTotal: number;
  osmFeaturesTotal: number;
}

export async function runOsmCrosscheck(params: OsmCrosscheckParams): Promise<OsmCrosscheckRunResult> {
  const bounds = params.bounds ?? KAMCHATKA_BOUNDS;

  const { rows: placeRows } = await pool.query<{
    id: string; name: string; location_type: string | null;
    lat: number | null; lng: number | null;
  }>(
    `SELECT id::text AS id, name, location_type, lat, lng
       FROM places
      WHERE is_visible = true AND merged_into_id IS NULL
        AND lat IS NOT NULL AND lng IS NOT NULL`,
  );
  const places: PlaceInput[] = placeRows.map(p => ({
    id: p.id, name: p.name, locationType: p.location_type,
    lat: p.lat == null ? null : Number(p.lat),
    lng: p.lng == null ? null : Number(p.lng),
  }));

  const features = await fetchOsmFeatures(bounds, { tilePauseMs: params.tilePauseMs });

  let simRows: SimilarityRow[] = [];
  if (places.length > 0 && features.length > 0) {
    // Один батч-запрос вместо места-за-местом: pg_trgm.similarity() уже
    // используется как скалярное выражение в places-dedup/route.ts —
    // расширение включено, новой миграции не требуется.
    const placeIds = places.map(p => p.id);
    const placeNames = places.map(p => p.name);
    const osmKeys = features.map(f => `${f.kind}:${f.id}`);
    const osmNames = features.map(f => f.name);

    const { rows } = await pool.query<{
      place_id: string; osm_key: string; sim: number;
    }>(
      `SELECT p.place_id, o.osm_key, similarity(p.place_name, o.osm_name) AS sim
         FROM unnest($1::text[], $2::text[]) AS p(place_id, place_name)
         CROSS JOIN unnest($3::text[], $4::text[]) AS o(osm_key, osm_name)
        WHERE similarity(p.place_name, o.osm_name) >= $5`,
      [placeIds, placeNames, osmKeys, osmNames, params.minSim],
    );

    simRows = rows.map(r => {
      const [kind, idStr] = r.osm_key.split(':');
      return {
        placeId: r.place_id,
        osmId: Number(idStr),
        osmKind: kind as SimilarityRow['osmKind'],
        sim: Number(r.sim),
      };
    });
  }

  const result = buildCrosscheckItems(places, features, simRows);

  return {
    ...result,
    checkedPlacesTotal: places.length,
    osmFeaturesTotal: features.length,
  };
}
