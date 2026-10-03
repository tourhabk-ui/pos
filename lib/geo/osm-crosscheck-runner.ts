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
  buildCrosscheckItems,
  type OsmFeature, type PlaceInput, type SimilarityRow, type CrosscheckResult,
} from '@/lib/geo/osm-crosscheck';
import { fetchOsmFeatures } from '@/lib/geo/osm-overpass-fetch';

// Сеть — отдельный модуль без базы (lib/geo/osm-overpass-fetch): тот же
// код зовёт и скрипт раннера GitHub, где DATABASE_URL нет.
export { fetchOsmFeatures };

export interface OsmCrosscheckParams {
  minSim: number;
  /** Пауза между квадратами Overpass; в тестах — 0. */
  tilePauseMs?: number;
  /**
   * Готовый список объектов OSM — выбран на раннере GitHub (POST роута).
   * Есть — Overpass с прода не спрашивается вовсе.
   */
  features?: OsmFeature[];
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

  const features = params.features ?? await fetchOsmFeatures(bounds, { tilePauseMs: params.tilePauseMs });

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
