/**
 * GET /api/cron/hidden-tracks-census — скрытые маршруты с настоящим треком.
 *
 * Проба 95 (20.08) показала: «Долина гейзеров», «Горный массив Вачкажец»,
 * «Пока дремлют вулканы» — маршруты с настоящими снятыми треками — не
 * отдаются каталогом: is_visible = false. Их треки лежат мёртвым грузом,
 * а места-тёзки из-за этого числятся «без линии на карте»: привязать место
 * к скрытому маршруту нельзя (актуатор требует живые обе стороны).
 *
 * Перепись отвечает, СКОЛЬКО таких и КАКИЕ: скрытый + не слитый + линия
 * LineString с >= 5 вершинами из не-синтетического источника (критерий
 * настоящего трека — тот же, что в lib/routes/twins: правило одно).
 * Для каждого — живое место-тёзка, если есть: кандидат на привязку после
 * восстановления. Решение о восстановлении — за человеком, ничего не пишет.
 *
 * READ-ONLY, Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { SYNTHETIC_SOURCES } from '@/lib/map/line-standard';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Тот же порог, что MIN_TRACK_POINTS в twins: меньше — огрызок, не трек. */
const MIN_POINTS = 5;
const SAMPLE_LIMIT = 80;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { rows } = await pool.query<{
      id: string; title: string; source: string | null; points: number;
      waypoint_count: number; tour_count: number;
      place_id: string | null; place_name: string | null;
      live_twin_id: string | null; live_twin_has_line: boolean | null;
    }>(
      `SELECT r.id::text AS id, r.title,
              r.geometry->>'source' AS source,
              jsonb_array_length(COALESCE(r.geometry->'coordinates', '[]'::jsonb)) AS points,
              (SELECT COUNT(*)::int FROM route_waypoints rw WHERE rw.route_id = r.id) AS waypoint_count,
              (SELECT COUNT(*)::int FROM operator_tours ot WHERE ot.route_id::text = r.id::text) AS tour_count,
              p.id::text AS place_id, p.name AS place_name,
              lt.id::text AS live_twin_id, lt.has_line AS live_twin_has_line
       FROM kamchatka_routes r
       LEFT JOIN places p
         ON p.is_visible = true AND p.merged_into_id IS NULL
        AND lower(translate(btrim(p.name), 'ё', 'е')) = lower(translate(btrim(r.title), 'ё', 'е'))
       -- Живой маршрут-тёзка: восстановление рядом с ним создало бы дубль на
       -- витрине, поэтому решение по таким — слияние, а не restore.
       LEFT JOIN LATERAL (
         SELECT r2.id, (r2.geometry IS NOT NULL) AS has_line
         FROM kamchatka_routes r2
         WHERE r2.is_visible = true AND r2.merged_into_id IS NULL
           AND lower(translate(btrim(r2.title), 'ё', 'е')) = lower(translate(btrim(r.title), 'ё', 'е'))
         ORDER BY (r2.geometry IS NOT NULL) DESC
         LIMIT 1
       ) lt ON true
       WHERE r.is_visible = false
         AND r.merged_into_id IS NULL
         AND r.geometry->>'type' = 'LineString'
         AND jsonb_array_length(COALESCE(r.geometry->'coordinates', '[]'::jsonb)) >= $1
         AND COALESCE(r.geometry->>'source', '') <> ALL($2)
       ORDER BY r.title`,
      [MIN_POINTS, [...SYNTHETIC_SOURCES]],
    );

    return NextResponse.json({
      success: true,
      probe: 'hidden_tracks_v2',
      hidden_with_real_track: rows.length,
      with_live_place_twin: rows.filter(r => r.place_id != null).length,
      with_live_route_twin: rows.filter(r => r.live_twin_id != null).length,
      items: rows.slice(0, SAMPLE_LIMIT),
      items_dropped: Math.max(0, rows.length - SAMPLE_LIMIT),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка переписи скрытых треков';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
