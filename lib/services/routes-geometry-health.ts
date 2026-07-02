/**
 * lib/services/routes-geometry-health.ts
 *
 * Health-метрика geometry маршрутов для offline-SOS (issue #249): без трека
 * (GeoJSON LineString) маршрут не работает офлайн на карте — turn-by-turn
 * навигация невозможна, что напрямую снижает безопасность туриста без связи.
 */

import { pool } from '@/lib/db-pool';

export interface RouteGeometryHealth {
  total: number;
  with_track: number;
  pct: number;
  ok: boolean;
  by_region: Array<{ zone: string | null; total: number; without_track: number }>;
}

const OK_THRESHOLD_PCT = 80;

/** Проверка валидности трека — coordinates должен быть массивом из ≥2 точек. */
const HAS_TRACK_SQL = `
  geometry IS NOT NULL
  AND jsonb_typeof(geometry->'coordinates') = 'array'
  AND jsonb_array_length(geometry->'coordinates') > 1
`;

export async function computeGeometryHealth(): Promise<RouteGeometryHealth> {
  const totalsRes = await pool.query<{ total: string; with_track: string }>(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE ${HAS_TRACK_SQL}) AS with_track
     FROM v_kamchatka_routes_api`,
  );
  const total = parseInt(totalsRes.rows[0]?.total ?? '0', 10);
  const with_track = parseInt(totalsRes.rows[0]?.with_track ?? '0', 10);
  const pct = total > 0 ? Math.round((with_track / total) * 1000) / 10 : 0;

  const byRegionRes = await pool.query<{ zone: string | null; total: string; without_track: string }>(
    `SELECT
       zone,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE NOT (${HAS_TRACK_SQL})) AS without_track
     FROM v_kamchatka_routes_api
     GROUP BY zone
     ORDER BY without_track DESC, zone ASC`,
  );

  return {
    total,
    with_track,
    pct,
    ok: pct >= OK_THRESHOLD_PCT,
    by_region: byRegionRes.rows.map(r => ({
      zone: r.zone,
      total: parseInt(r.total, 10),
      without_track: parseInt(r.without_track, 10),
    })),
  };
}
