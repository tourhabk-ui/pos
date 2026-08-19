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
 * Пул импорта: geometry IS NULL ИЛИ синтетика миграции 168 (прямые линии по
 * waypoints, geometry->>'source' = 'waypoints_synthetic' после бэкфилла 776) —
 * реальный OSM-трек её перекрывает, как и обещал комментарий 168-й. Реальные
 * треки (source 'osm'/'idilesom'/'visitkamchatka' или без source) не трогаем.
 * Импортированный трек помечается in-band: source='osm' внутри GeoJSON — эту
 * конвенцию уже читает дедуп idilesom-скрипта.
 *
 * offset нужен batched-прогону: маршруты, для которых в OSM не нашлось трека
 * (skipped) или случилась ошибка, остаются в пуле и без offset попадали бы
 * в каждую следующую партию, зацикливая перебор.
 */

import { pool } from '@/lib/db-pool';
import {
  buildOverpassQuery, parseOverpassWays, chooseWay, wayToGeoJSON,
  type OsmWay, type WayChoiceReason,
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
  'User-Agent': 'KamchatourHub-OSM-Import/1.0 (+https://vedarai.ru)',
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
  /**
   * Чем кончился выбор тропы. Раньше все отказы выглядели одинаково, и
   * разобрать, чего не хватило, было нечем.
   */
  reason?: WayChoiceReason;
  /** Выбранная тропа OSM — чтобы сухой прогон можно было проверить глазами. */
  wayId?: number;
  wayName?: string | null;
  /** Ближайший конец тропы до якоря маршрута, км. */
  startDistKm?: number | null;
  /** Худшее расстояние путевой точки маршрута до тропы, км. */
  worstWaypointKm?: number | null;
  /** Кандидат, который помешал выбрать однозначно. */
  runnerUpId?: number | null;
  /** Что затирается: источник нынешней геометрии (null — геометрии не было). */
  currentSource?: string | null;
}

export interface OsmImportResult {
  dry_run: boolean;
  imported: number;
  skipped: number;
  errors: string[];
  /** Совсем без геометрии (geometry IS NULL). */
  routes_without_geometry: number;
  /** С синтетической геометрией миграции 168 — кандидаты на апгрейд. */
  routes_synthetic: number;
  /** Весь оставшийся пул (NULL + синтетика) — по нему цикл workflow решает, продолжать ли. */
  remaining_total: number;
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

  // Сначала маршруты совсем без геометрии, потом апгрейд синтетики
  const { rows: routes } = await pool.query<{
    id: string; title: string; lat: string; lng: string;
    current_source: string | null;
    waypoints: Array<{ lat: number; lng: number }>;
  }>(`
    SELECT kr.id, kr.title, kr.lat::text, kr.lng::text,
           kr.geometry->>'source' AS current_source,
           COALESCE(
             (SELECT json_agg(json_build_object('lat', p.lat::float8, 'lng', p.lng::float8))
                FROM route_waypoints rw
                JOIN places p ON p.id = rw.place_id
               WHERE rw.route_id = kr.id
                 AND p.lat IS NOT NULL AND p.lng IS NOT NULL),
             '[]'::json
           ) AS waypoints
    FROM kamchatka_routes kr
    WHERE is_visible = true
      AND kr.lat IS NOT NULL AND kr.lng IS NOT NULL
      AND (kr.geometry IS NULL OR kr.geometry->>'source' = 'waypoints_synthetic')
    ORDER BY (kr.geometry IS NULL) DESC, kr.title
    LIMIT $1 OFFSET $2
  `, [limit, offset]);

  const totals = await pool.query<{ without_geometry: string; synthetic: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE geometry IS NULL)::text AS without_geometry,
       COUNT(*) FILTER (WHERE geometry->>'source' = 'waypoints_synthetic')::text AS synthetic
     FROM kamchatka_routes
     WHERE is_visible = true AND lat IS NOT NULL AND lng IS NOT NULL`
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
      const choice = chooseWay(ways, lat, lng, r.waypoints ?? []);

      if (!choice.way) {
        skipped++;
        // Причина отказа сохраняется. Прежде все отказы выглядели одинаково
        // («skipped»), и разобрать, чего не хватило — тропы поблизости, точек
        // маршрута или однозначности, — было нечем.
        details.push({
          id: r.id, title: r.title, status: 'skipped', reason: choice.reason,
          worstWaypointKm: choice.worstWaypointKm, runnerUpId: choice.runnerUpId,
          currentSource: r.current_source,
        });
      } else {
        const geojson = wayToGeoJSON(choice.way, lat, lng);
        if (!dryRun) {
          // Условие повторяет отбор: между SELECT и UPDATE строка могла
          // измениться — например, прошлой партией того же прогона. Без него
          // запись шла бы поверх геометрии, которую пул уже не считал бы
          // перезаписываемой.
          await pool.query(
            `UPDATE kamchatka_routes SET geometry = $1
              WHERE id = $2
                AND (geometry IS NULL OR geometry->>'source' = 'waypoints_synthetic')`,
            [JSON.stringify({ ...geojson, source: 'osm' }), r.id],
          );
        }
        imported++;
        details.push({
          id: r.id, title: r.title, status: dryRun ? 'dry_run' : 'imported',
          pts: geojson.coordinates.length,
          reason: choice.reason,
          // Что именно выбрано и что затирается — без этого сухой прогон
          // отвечает «сколько», но не «то ли».
          wayId: choice.way.id,
          wayName: choice.way.tags?.name ?? null,
          startDistKm: choice.startDistKm,
          worstWaypointKm: choice.worstWaypointKm,
          runnerUpId: choice.runnerUpId,
          currentSource: r.current_source,
        });
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

  const withoutGeometry = parseInt(totals.rows[0].without_geometry);
  const synthetic = parseInt(totals.rows[0].synthetic);

  return {
    dry_run: dryRun,
    imported,
    skipped,
    errors,
    routes_without_geometry: withoutGeometry,
    routes_synthetic: synthetic,
    remaining_total: withoutGeometry + synthetic,
    processed: routes.length,
    details,
  };
}
