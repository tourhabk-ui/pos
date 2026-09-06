/**
 * lib/services/routes-geometry-health.ts
 *
 * Health-метрика geometry маршрутов для offline-SOS (issue #249): без трека
 * (GeoJSON LineString) маршрут не работает офлайн на карте — turn-by-turn
 * навигация невозможна, что напрямую снижает безопасность туриста без связи.
 */

import { pool } from '@/lib/db-pool';
import { GEOMETRY_GAP_WARN_PCT } from '@/lib/home/data-freshness';

export interface RouteGeometryHealth {
  total: number;
  with_track: number;
  pct: number;
  ok: boolean;
  by_region: Array<{ zone: string | null; total: number; without_track: number }>;
  missing_geometry_ids: string[];
}

/** Порог «ok» — обратная сторона порога тревоги главной: одно число, два прибора (#1643). */
const OK_THRESHOLD_PCT = 100 - GEOMETRY_GAP_WARN_PCT;
const MAX_MISSING_IDS = 200;

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
     FROM kamchatka_routes
     WHERE (is_visible = TRUE OR is_visible IS NULL)`,
  );
  const total = parseInt(totalsRes.rows[0]?.total ?? '0', 10);
  const with_track = parseInt(totalsRes.rows[0]?.with_track ?? '0', 10);
  const pct = total > 0 ? Math.round((with_track / total) * 1000) / 10 : 0;

  const byRegionRes = await pool.query<{ zone: string | null; total: string; without_track: string }>(
    `SELECT
       zone,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE NOT (${HAS_TRACK_SQL})) AS without_track
     FROM kamchatka_routes
     WHERE (is_visible = TRUE OR is_visible IS NULL)
     GROUP BY zone
     ORDER BY without_track DESC, zone ASC`,
  );

  const missingRes = await pool.query<{ id: string }>(
    `SELECT id::text FROM kamchatka_routes
     WHERE (is_visible = TRUE OR is_visible IS NULL)
       AND NOT (${HAS_TRACK_SQL})
     ORDER BY id
     LIMIT ${MAX_MISSING_IDS}`,
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
    missing_geometry_ids: missingRes.rows.map(r => r.id),
  };
}

/**
 * Сколько живых маршрутов офлайн-карта не покажет линией (#1643).
 *
 * Считается НАЛИЧИЕ линии, а не право вести по ней. Право вести решает
 * `lib/routes/navigability` (§12), и одним запросом оно не считается: ему
 * нужны путевые точки, улика записи, способ передвижения и род паспорта на
 * каждый маршрут. Набросок прямыми и линия из скрейпа попадут сюда в
 * «линия есть» — так и задумано, потому что подпись обещает ровно наличие.
 * Называть это «треком» нельзя: в §12 трек — род линии, дающий право вести.
 */
export interface RouteGeometryGap {
  /** Живых маршрутов: is_visible и не слитых (merged_into_id IS NULL). */
  total: number;
  /** Без линии, пригодной для показа офлайн: geometry NULL ИЛИ без двух вершин. Надмножество geometry_null. */
  without_track: number;
  /** Строго geometry IS NULL — линии нет вовсе. */
  geometry_null: number;
}

function intOrNull(v: unknown): number | null {
  const n = typeof v === 'string' ? parseInt(v, 10) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Лёгкий счётчик для главной: один запрос, без разбивки по зонам и списка id.
 *
 * Живой маршрут — is_visible И не слитый: слитые дубли витрина не показывает,
 * и без второго фильтра пробел завышался бы на каждый merge (как в аудите 869).
 *
 * Третье состояние (§4.0): упавший запрос — null и строка в лог с SQLSTATE,
 * а не ноль. Ноль без трека после упавшего запроса неотличим от полного покрытия.
 */
export async function countRoutesWithoutGeometry(): Promise<RouteGeometryGap | null> {
  try {
    const { rows } = await pool.query<{ total: string; without_track: string; geometry_null: string }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE NOT (${HAS_TRACK_SQL}))::text AS without_track,
         COUNT(*) FILTER (WHERE geometry IS NULL)::text AS geometry_null
       FROM kamchatka_routes
       WHERE is_visible = TRUE AND merged_into_id IS NULL`,
    );
    const row = rows[0];
    const total = intOrNull(row?.total);
    const withoutTrack = intOrNull(row?.without_track);
    const geometryNull = intOrNull(row?.geometry_null);
    if (total === null || withoutTrack === null || geometryNull === null) {
      console.error('[routes-geometry] счётчик без трека вернул не число:', row);
      return null;
    }
    return { total, without_track: withoutTrack, geometry_null: geometryNull };
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '?';
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[routes-geometry] счётчик без трека не выполнился (SQLSTATE ${code}): ${message}`);
    return null;
  }
}
