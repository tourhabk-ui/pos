/**
 * GET /api/cron/route-corpus — весь живой справочник маршрутов одним куском.
 * Bearer CRON_SECRET, только чтение.
 *
 * ── Зачем целиком ──────────────────────────────────────────────────────────
 *
 * Все прежние переписи смотрят на маршруты ПО ОДНОМУ и отвечают на заранее
 * заданный вопрос: у скольких нет линии (`route-lay-census`), у скольких имя
 * вне канона (`route-title-census`), откуда линия (`catalog-census`). Каждая
 * права в своём вопросе и слепа к тому, что видно только между записями:
 *
 *   — два разных маршрута с ОДИНАКОВЫМ набором путевых точек (миграция 167
 *     раздавала «места в 15 км от центра», и такие пары в данных есть);
 *   — имя обещает объект, которого нет ни в точках, ни в описании;
 *   — тёзки: «Спокойный» у водопада и у маршрута за 600 км (§4.1);
 *   — набор точек, принадлежащий соседнему маршруту.
 *
 * Чтобы это увидеть, надо держать перед глазами ВЕСЬ корпус сразу. 294
 * маршрута с фактами — десятки тысяч токенов; модель с контекстом на миллион
 * читает их за один проход. Отсюда эндпоинт, отдающий корпус целиком.
 *
 * Он ничего не решает и ничего не пишет: судит раннер, а решает человек.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Описание режется: разбор про строение корпуса, а не про прозу. */
const DESCRIPTION_HEAD = 400;

interface Row {
  id: string;
  title: string;
  description_head: string | null;
  description_len: number;
  zone: string | null;
  activity_type: string | null;
  season: string | null;
  route_type: string | null;
  distance_km: string | null;
  elevation_gain_m: number | null;
  duration_hours: string | null;
  lat: string | null;
  lng: string | null;
  geometry_source: string;
  geometry_points: number | null;
  hazards: string[] | null;
  equipment: string[] | null;
  park_name: string | null;
  waypoints: string[] | null;
  nearby: string[] | null;
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { rows } = await pool.query<Row>(
      `SELECT r.id::text AS id,
              r.title,
              LEFT(r.description, $1) AS description_head,
              COALESCE(LENGTH(r.description), 0)::int AS description_len,
              r.zone, r.activity_type, r.season, r.route_type,
              r.distance_km::text, r.elevation_gain_m, r.duration_hours::text,
              r.lat::text, r.lng::text,
              COALESCE(r.geometry->>'source', 'нет геометрии') AS geometry_source,
              CASE
                WHEN jsonb_typeof(r.geometry->'coordinates') = 'array'
                THEN jsonb_array_length(r.geometry->'coordinates')
                ELSE NULL
              END AS geometry_points,
              r.hazards, r.equipment, r.park_name,
              -- Путевые точки в порядке прохождения. Род связи назван прямо:
              -- 'nearby' — «это рядом», такая точка путём не является и линию
              -- ею сверять нельзя (§4.1, миграция 874).
              ARRAY(
                SELECT p.name || CASE
                         WHEN rw.link_kind = 'nearby'  THEN ' [рядом]'
                         WHEN rw.link_kind = 'unknown' THEN ' [род не установлен]'
                         ELSE ''
                       END
                  FROM route_waypoints rw
                  JOIN places p ON p.id = rw.place_id
                 WHERE rw.route_id = r.id
                   AND p.is_visible = true AND p.merged_into_id IS NULL
                 ORDER BY rw.position
              ) AS waypoints,
              -- Соседи по координате: материал для суждения «имя обещает
              -- объект, которого в точках нет». Пусто — координаты нет или
              -- рядом никого; это честный ответ, а не повод выдумать.
              ARRAY(
                SELECT p2.name || ' ~' ||
                       ROUND(sqrt(power(111.0 * (p2.lat::float8 - r.lat::float8), 2)
                                + power(67.0 * (p2.lng::float8 - r.lng::float8), 2))::numeric, 1) || ' км'
                  FROM places p2
                 WHERE r.lat IS NOT NULL AND r.lng IS NOT NULL
                   AND p2.is_visible = true AND p2.merged_into_id IS NULL
                   AND p2.lat IS NOT NULL AND p2.lng IS NOT NULL
                   AND p2.lat::float8 BETWEEN r.lat::float8 - 0.15 AND r.lat::float8 + 0.15
                   AND p2.lng::float8 BETWEEN r.lng::float8 - 0.25 AND r.lng::float8 + 0.25
                 ORDER BY power(111.0 * (p2.lat::float8 - r.lat::float8), 2)
                        + power(67.0 * (p2.lng::float8 - r.lng::float8), 2)
                 LIMIT 3
              ) AS nearby
         FROM kamchatka_routes r
        WHERE r.is_visible = true AND r.merged_into_id IS NULL
        ORDER BY r.title`,
      [DESCRIPTION_HEAD],
    );

    const routes = rows.map((r) => ({
      id: r.id,
      title: r.title,
      description_head: r.description_head,
      description_len: r.description_len,
      zone: r.zone,
      activity_type: r.activity_type,
      season: r.season,
      route_type: r.route_type,
      distance_km: r.distance_km === null ? null : Number(r.distance_km),
      elevation_gain_m: r.elevation_gain_m,
      duration_hours: r.duration_hours === null ? null : Number(r.duration_hours),
      lat: r.lat === null ? null : Number(r.lat),
      lng: r.lng === null ? null : Number(r.lng),
      geometry_source: r.geometry_source,
      geometry_points: r.geometry_points,
      hazards: r.hazards ?? [],
      equipment: r.equipment ?? [],
      park_name: r.park_name,
      waypoints: r.waypoints ?? [],
      nearby: r.nearby ?? [],
    }));

    return NextResponse.json({
      probe: 'route_corpus_v1',
      contract_version: 1,
      checked_at: new Date().toISOString(),
      total: routes.length,
      // Счётчики рядом с корпусом — чтобы разбор было с чем сверить, а
      // читающему не пришлось верить пересказу модели на слово.
      summary: {
        without_geometry: routes.filter((r) => r.geometry_source === 'нет геометрии').length,
        without_waypoints: routes.filter((r) => r.waypoints.length === 0).length,
        without_coords: routes.filter((r) => r.lat === null || r.lng === null).length,
        without_description: routes.filter((r) => r.description_len === 0).length,
      },
      routes,
    });
  } catch (err) {
    // Отказ — «не смог прочитать», а не «маршрутов нет» (§4.0).
    const message = err instanceof Error ? err.message : String(err);
    console.error('[route-corpus] корпус не прочитан:', message);
    return NextResponse.json(
      { probe: 'route_corpus_v1', contract_version: 1, error: message }, { status: 500 },
    );
  }
}
