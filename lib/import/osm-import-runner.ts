/**
 * Раннер импорта GPS-треков маршрутов из OSM Overpass в kamchatka_routes.geometry.
 *
 * Извлечён из app/api/admin/import/osm-geometry/route.ts, чтобы тот же цикл
 * использовал и крон-эндпоинт /api/cron/osm-import (запуск с прод-сервера:
 * файрвол managed PostgreSQL Timeweb не пускает внешние IP GitHub-раннеров,
 * а с самого прода БД доступна нативно).
 *
 * Чистая геометрия (bbox, выбор пути, LineString) — в lib/import/osm-geometry.ts.
 * Здесь — сеть (Overpass) + БД (выборка маршрутов без geometry, UPDATE).
 *
 * offset нужен batched-прогону: маршруты, для которых в OSM не нашлось трека
 * (skipped) или случилась ошибка, остаются с geometry IS NULL и без offset
 * попадали бы в каждую следующую партию, зацикливая перебор.
 */

import { pool } from '@/lib/db-pool';
import {
  buildOverpassQuery, parseOverpassWays, pickBestWay, wayToGeoJSON,
  type OsmWay,
} from '@/lib/import/osm-geometry';

// Основной инстанс + зеркало. Primary с 2025-го отвечает 406 запросам без
// осмысленного User-Agent (generic-клиенты режутся etiquette-фильтром), поэтому
// шлём идентифицирующие заголовки; при не-2xx пробуем зеркало Kumi Systems.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OSM_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'Accept': 'application/json',
  'User-Agent': 'KamchatourHub-OSM-Import/1.0 (+https://tourhab.ru)',
};
const DEFAULT_DELAY_MS = 1300; // пауза между запросами — щадим rate-limit Overpass

export interface OsmImportParams {
  limit: number;
  dryRun: boolean;
  offset?: number;
  /** Пауза между Overpass-запросами, мс (в тестах — 0). */
  delayMs?: number;
}

export interface OsmImportDetail {
  id: string;
  title: string;
  status: 'imported' | 'dry_run' | 'skipped' | 'error';
  pts?: number;
}

export interface OsmImportResult {
  dry_run: boolean;
  imported: number;
  skipped: number;
  errors: string[];
  routes_without_geometry: number;
  processed: number;
  details: OsmImportDetail[];
}

async function fetchOsmWays(lat: number, lng: number): Promise<OsmWay[]> {
  const body = `data=${encodeURIComponent(buildOverpassQuery(lat, lng))}`;
  let lastError: Error = new Error('Overpass: нет доступных эндпоинтов');

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: OSM_HEADERS,
        body,
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        lastError = new Error(`Overpass HTTP ${res.status} (${new URL(endpoint).host})`);
        continue;
      }
      return parseOverpassWays(await res.json());
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError;
}

export async function runOsmGeometryImport(params: OsmImportParams): Promise<OsmImportResult> {
  const { limit, dryRun } = params;
  const offset = params.offset ?? 0;
  const delayMs = params.delayMs ?? DEFAULT_DELAY_MS;

  const { rows: routes } = await pool.query<{
    id: string; title: string; lat: string; lng: string;
  }>(`
    SELECT id, title, lat::text, lng::text
    FROM kamchatka_routes
    WHERE is_visible = true
      AND lat IS NOT NULL AND lng IS NOT NULL
      AND geometry IS NULL
    ORDER BY title
    LIMIT $1 OFFSET $2
  `, [limit, offset]);

  const totalWithoutGeometry = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM kamchatka_routes
     WHERE is_visible = true AND lat IS NOT NULL AND lng IS NOT NULL AND geometry IS NULL`
  );

  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];
  const details: OsmImportDetail[] = [];

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
        if (!dryRun) {
          await pool.query(
            `UPDATE kamchatka_routes SET geometry = $1 WHERE id = $2`,
            [JSON.stringify(geojson), r.id],
          );
        }
        imported++;
        details.push({ id: r.id, title: r.title, status: dryRun ? 'dry_run' : 'imported', pts: geojson.coordinates.length });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${r.title}: ${msg}`);
      details.push({ id: r.id, title: r.title, status: 'error' });
    }

    if (delayMs > 0 && i < routes.length - 1) {
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }

  return {
    dry_run: dryRun,
    imported,
    skipped,
    errors,
    routes_without_geometry: parseInt(totalWithoutGeometry.rows[0].count),
    processed: routes.length,
    details,
  };
}
