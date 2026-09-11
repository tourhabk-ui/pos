/**
 * Раннер сверки вулканов `places` с Global Volcanism Program — сеть + БД.
 *
 * Чистая логика (сборка кандидатов) — в `lib/geo/gvp-crosscheck.ts`. Здесь
 * только IO: один GET к публичному WFS (ключ не нужен), выборка живых
 * places с `location_type = 'volcano'`. НИ ОДНОГО write-запроса — ни
 * UPDATE, ни INSERT, ни DELETE, ни при каком аргументе: инструмент только
 * показывает кандидатов, решение и правку делает человек через
 * `POST /api/cron/place-coords` (с источником) или отдельную миграцию
 * (скрытие без источника) — как уже сделано для OSM-находок 10.09.
 */

import { pool } from '@/lib/db-pool';
import { KAMCHATKA_BOUNDS } from '@/lib/services/routes/geocode';
import {
  buildGvpFeatureUrl, parseGvpFeatures, buildVolcanoCrosscheckItems,
  type GvpVolcano, type PlaceInput, type VolcanoCrosscheckResult,
} from '@/lib/geo/gvp-crosscheck';

const GVP_HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'KamchatourHub-GVP-Crosscheck/1.0 (+https://vedarai.ru)',
};

/** Один слой на 1214 записей мира, обрезанный propertyName+bbox — секунды, не минуты. */
const GVP_TIMEOUT_MS = 30_000;

export async function fetchGvpVolcanoes(bounds = KAMCHATKA_BOUNDS): Promise<GvpVolcano[]> {
  const url = buildGvpFeatureUrl(bounds);
  const res = await fetch(url, {
    headers: GVP_HEADERS,
    signal: AbortSignal.timeout(GVP_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`GVP WFS HTTP ${res.status}`);
  }
  return parseGvpFeatures(await res.json());
}

export interface GvpCrosscheckRunResult extends VolcanoCrosscheckResult {
  checkedPlacesTotal: number;
  gvpVolcanoesTotal: number;
}

export async function runGvpCrosscheck(bounds = KAMCHATKA_BOUNDS): Promise<GvpCrosscheckRunResult> {
  const { rows: placeRows } = await pool.query<{
    id: string; name: string; location_type: string | null;
    lat: number | null; lng: number | null;
  }>(
    `SELECT id::text AS id, name, location_type, lat, lng
       FROM places
      WHERE is_visible = true AND merged_into_id IS NULL
        AND location_type = 'volcano'
        AND lat IS NOT NULL AND lng IS NOT NULL`,
  );
  const places: PlaceInput[] = placeRows.map(p => ({
    id: p.id, name: p.name, locationType: p.location_type,
    lat: p.lat == null ? null : Number(p.lat),
    lng: p.lng == null ? null : Number(p.lng),
  }));

  const volcanoes = await fetchGvpVolcanoes(bounds);
  const result = buildVolcanoCrosscheckItems(places, volcanoes);

  return {
    ...result,
    checkedPlacesTotal: places.length,
    gvpVolcanoesTotal: volcanoes.length,
  };
}
