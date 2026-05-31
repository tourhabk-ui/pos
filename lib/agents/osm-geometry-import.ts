/**
 * lib/agents/osm-geometry-import.ts
 *
 * Загружает GPS-треки из OpenStreetMap Overpass API для маршрутов
 * у которых geometry IS NULL.
 *
 * Алгоритм:
 * 1. Группируем маршруты в кластеры по близости (MAX_CLUSTER_SIZE маршрутов)
 * 2. Один Overpass запрос на кластер (bbox охватывает все маршруты группы)
 * 3. Запросы выполняются параллельно (PARALLEL_LIMIT кластеров одновременно)
 * 4. Для каждого маршрута ищем лучший путь в полученных данных
 *    — сначала по совпадению имени в OSM тегах
 *    — затем по близости к точке старта
 *
 * Результат: ~294 маршрута за 1 прогон (~3-4 мин) вместо 8 прогонов за 3 дня.
 */

import { pool } from '@/lib/db-pool';

const OVERPASS = 'https://overpass-api.de/api/interpreter';
const BBOX_PAD_LAT = 0.05;   // расширение bbox кластера (градусы)
const BBOX_PAD_LNG = 0.07;
const MAX_START_DIST_KM = 5; // максимум расстояние от точки маршрута до старта OSM пути
const MAX_CLUSTER_SIZE = 10; // маршрутов в одном Overpass запросе
const PARALLEL_LIMIT = 4;    // параллельных запросов к Overpass

export interface OsmImportResult {
  imported: number;
  skipped: number;
  errors: number;
  error_details: string[];
  routes_without_geometry: number;
  processed: number;
  details: Array<{ id: string; title: string; status: string; pts?: number }>;
}

interface RouteRow { id: string; title: string; lat: string; lng: string; }
interface OsmNode  { lat: number; lon: number; }
interface OsmWay   { id: number; tags: Record<string, string>; geometry: OsmNode[]; }

function distKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Загружает все OSM-пути в bbox покрывающем весь кластер маршрутов */
async function fetchWaysForCluster(routes: RouteRow[]): Promise<OsmWay[]> {
  const lats = routes.map(r => parseFloat(r.lat));
  const lngs = routes.map(r => parseFloat(r.lng));
  const s = Math.min(...lats) - BBOX_PAD_LAT;
  const n = Math.max(...lats) + BBOX_PAD_LAT;
  const w = Math.min(...lngs) - BBOX_PAD_LNG;
  const e = Math.max(...lngs) + BBOX_PAD_LNG;

  const q = `[out:json][timeout:45];way["highway"~"path|track|footway"](${s},${w},${n},${e});out geom;`;

  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(q)}`,
    signal: AbortSignal.timeout(50_000),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  const data = await res.json() as { elements: OsmWay[] };
  return (data.elements ?? []).filter(e => e.geometry && e.geometry.length >= 3);
}

/** Нормализует строку для сравнения имён */
function normName(s: string): string {
  return s.toLowerCase()
    .replace(/вулкан|volcano|гора|mount|озеро|lake|река|river/gi, '')
    .replace(/[^а-яёa-z0-9]/gi, '')
    .trim();
}

/** Выбирает лучший OSM путь для маршрута:
 *  1. Совпадение имени в тегах OSM (name/alt_name)
 *  2. Близость к точке старта + длина трека
 */
function pickBestWay(ways: OsmWay[], lat: number, lng: number, title: string): OsmWay | null {
  const norm = normName(title);

  // Приоритет 1: совпадение имени
  if (norm.length > 4) {
    const byName = ways.filter(w => {
      const osmName = normName(w.tags?.name ?? '') || normName(w.tags?.['alt_name'] ?? '');
      return osmName && (osmName.includes(norm) || norm.includes(osmName));
    });
    if (byName.length > 0) {
      byName.sort((a, b) => b.geometry.length - a.geometry.length);
      return byName[0];
    }
  }

  // Приоритет 2: близость к точке маршрута
  const scored = ways.map(w => {
    const first = w.geometry[0];
    const last  = w.geometry[w.geometry.length - 1];
    const startDist = Math.min(
      distKm(lat, lng, first.lat, first.lon),
      distKm(lat, lng, last.lat,  last.lon),
    );
    return { w, startDist, nodeCount: w.geometry.length };
  });

  const nearby = scored.filter(s => s.startDist <= MAX_START_DIST_KM);
  if (nearby.length === 0) return null;
  nearby.sort((a, b) => b.nodeCount - a.nodeCount);
  return nearby[0].w;
}

function wayToGeoJSON(way: OsmWay, routeLat: number, routeLng: number) {
  const first = way.geometry[0];
  const last  = way.geometry[way.geometry.length - 1];
  const distFirst = distKm(routeLat, routeLng, first.lat, first.lon);
  const distLast  = distKm(routeLat, routeLng, last.lat,  last.lon);
  const coords = distLast < distFirst
    ? [...way.geometry].reverse().map(n => [n.lon, n.lat])
    : way.geometry.map(n => [n.lon, n.lat]);
  return { type: 'LineString', coordinates: coords };
}

/** Кластеризация: группируем маршруты по географической близости */
function clusterRoutes(routes: RouteRow[]): RouteRow[][] {
  const clusters: RouteRow[][] = [];
  const used = new Set<string>();

  for (const r of routes) {
    if (used.has(r.id)) continue;
    const lat = parseFloat(r.lat);
    const lng = parseFloat(r.lng);

    // Ищем существующий кластер где есть место и маршруты близко
    let placed = false;
    for (const cluster of clusters) {
      if (cluster.length >= MAX_CLUSTER_SIZE) continue;
      const clat = parseFloat(cluster[0].lat);
      const clng = parseFloat(cluster[0].lng);
      if (distKm(lat, lng, clat, clng) < 50) { // 50 км — маршруты в одном кластере
        cluster.push(r);
        used.add(r.id);
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.push([r]);
      used.add(r.id);
    }
  }
  return clusters;
}

/** Параллельный запуск с ограничением concurrency */
async function withConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

export async function runOsmGeometryImport(
  limit = 294,
  dry_run = false,
): Promise<OsmImportResult> {
  const { rows: routes } = await pool.query<RouteRow>(`
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
  let skipped  = 0;
  const errorMessages: string[] = [];
  const details: OsmImportResult['details'] = [];

  if (routes.length === 0) {
    return { imported: 0, skipped: 0, errors: 0, error_details: [], routes_without_geometry: 0, processed: 0, details: [] };
  }

  // Кластеризация маршрутов
  const clusters = clusterRoutes(routes);

  // Задачи: по одному Overpass запросу на кластер
  const tasks = clusters.map(cluster => async () => {
    let ways: OsmWay[] = [];
    try {
      ways = await fetchWaysForCluster(cluster);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return cluster.map(r => ({ r, status: 'error' as const, msg }));
    }

    return cluster.map(r => {
      const lat = parseFloat(r.lat);
      const lng = parseFloat(r.lng);
      const best = pickBestWay(ways, lat, lng, r.title);
      if (!best) return { r, status: 'skipped' as const };
      return { r, status: 'ok' as const, geojson: wayToGeoJSON(best, lat, lng) };
    });
  });

  // Параллельно с лимитом
  const clusterResults = await withConcurrency(tasks, PARALLEL_LIMIT);

  // Собираем результаты и пишем в БД батчем
  const updates: Array<{ id: string; geojson: string }> = [];

  for (const clusterResult of clusterResults) {
    for (const item of clusterResult) {
      if (item.status === 'error') {
        errorMessages.push(`${item.r.title}: ${item.msg}`);
        details.push({ id: item.r.id, title: item.r.title, status: 'error' });
      } else if (item.status === 'skipped') {
        skipped++;
        details.push({ id: item.r.id, title: item.r.title, status: 'skipped' });
      } else {
        imported++;
        details.push({ id: item.r.id, title: item.r.title, status: dry_run ? 'dry_run' : 'imported', pts: item.geojson.coordinates.length });
        if (!dry_run) updates.push({ id: item.r.id, geojson: JSON.stringify(item.geojson) });
      }
    }
  }

  // Батч UPDATE через unnest
  if (updates.length > 0) {
    await pool.query(
      `UPDATE kamchatka_routes AS kr
       SET geometry = u.geojson::jsonb
       FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::text[]) AS geojson) u
       WHERE kr.id = u.id`,
      [updates.map(u => u.id), updates.map(u => u.geojson)],
    );
  }

  return {
    imported,
    skipped,
    errors: errorMessages.length,
    error_details: errorMessages.slice(0, 10),
    routes_without_geometry: Math.max(0, parseInt(countRows[0].count) - imported),
    processed: routes.length,
    details: details.slice(0, 100),
  };
}
