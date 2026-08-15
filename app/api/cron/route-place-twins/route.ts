/**
 * GET /api/cron/route-place-twins — сколько «маршрутов» на самом деле места.
 *
 * Подсказчик привязки (проба 61) вскрыл конструкционную беду: почти у
 * каждого осиротевшего места единственный кандидат в маршруты — запись с
 * ТЕМ ЖЕ названием, нулём путевых точек и без дистанции. Это не маршрут,
 * а карточка места, заведённая в таблицу маршрутов при импорте
 * (visitkamchatka/idilesom заводили каждую достопримечательность как
 * «маршрут»). Отсюда и цифры аудита: 346 живых маршрутов из 404 без
 * единой точки, 319 без дистанции — заполнять там нечего по существу.
 *
 * Перепись меряет масштаб тремя срезами:
 *   exact_twins   — живой маршрут, чьё название совпадает с живым местом;
 *   silent_routes — живой маршрут без точек И без дистанции (не обязан
 *                   быть двойником: может быть просто пустой карточкой);
 *   both          — пересечение: почти наверняка «это место, не маршрут».
 *
 * READ-ONLY, Bearer CRON_SECRET. Ничего не скрывает и не удаляет —
 * решение о судьбе двойников за владельцем.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SAMPLE_LIMIT = 120;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Сравнение имён: регистр, ё и хвостовые пробелы не считаются
    // различием. Всё остальное — считается: «Вулкан Горелый» и «Горелый»
    // это РАЗНЫЕ строки, и записывать их в двойники по догадке нельзя.
    const { rows } = await pool.query<{
      route_id: string; title: string; place_id: string | null;
      waypoint_count: number; has_distance: boolean; has_geometry: boolean;
    }>(
      `SELECT r.id::text AS route_id, r.title,
              p.id::text AS place_id,
              (SELECT COUNT(*)::int FROM route_waypoints rw WHERE rw.route_id = r.id) AS waypoint_count,
              (r.distance_km IS NOT NULL) AS has_distance,
              (r.geometry IS NOT NULL) AS has_geometry
       FROM kamchatka_routes r
       LEFT JOIN places p
         ON p.is_visible = true AND p.merged_into_id IS NULL
        AND lower(translate(btrim(p.name), 'ё', 'е')) = lower(translate(btrim(r.title), 'ё', 'е'))
       WHERE r.is_visible = true AND r.merged_into_id IS NULL`,
    );

    const liveRoutes = rows.length;
    const twins = rows.filter(r => r.place_id != null);
    const silent = rows.filter(r => r.waypoint_count === 0 && !r.has_distance);
    const both = twins.filter(r => r.waypoint_count === 0 && !r.has_distance);

    return NextResponse.json({
      success: true,
      live_routes: liveRoutes,
      exact_twins: twins.length,
      silent_routes: silent.length,
      twins_and_silent: both.length,
      // Двойник с точками — не всегда ошибка: маршрут «Долина гейзеров»
      // с четырьмя waypoints это настоящий маршрут, названный по цели.
      twins_with_waypoints: twins.filter(r => r.waypoint_count > 0).length,
      sample_twins_and_silent: both.slice(0, SAMPLE_LIMIT).map(r => ({
        routeId: r.route_id, placeId: r.place_id, title: r.title, hasGeometry: r.has_geometry,
      })),
      sample_dropped: Math.max(0, both.length - SAMPLE_LIMIT),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка переписи двойников';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
