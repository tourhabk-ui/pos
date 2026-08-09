/**
 * GET /api/cron/relief-coverage
 *
 * Сколько маршрутов на проде реально несут высоты — и откуда эти треки.
 *
 * Владелец 09.08 поправил меня: «схема высот есть на иди лесом». Я перед этим
 * предположил, что профиль на проде не покажется, опираясь на строчку в
 * CLAUDE.md про неимпортированные треки OSM. Но треки идут не только из OSM:
 * `idilesom-importer` пишет их прямо в `kamchatka_routes.geometry`, причём
 * предпочитает формат С высотой. Значит вопрос решается замером, а не
 * рассуждением: сколько маршрутов имеют трек, у скольких в координатах есть
 * третье число, и по каким источникам они распределены.
 *
 * Read-only: единственный запрос — SELECT с агрегатами. Ни координат, ни
 * названий наружу не уходит, только счётчики.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { verifyCronSecret } from '@/lib/auth/cron';
import { MIN_ELEVATION_COVERAGE } from '@/lib/routes/relief';

export const dynamic = 'force-dynamic';

interface CoverageRow {
  source: string | null;
  routes: string;
  with_track: string;
  with_elevation: string;
  points_total: string;
  points_with_ele: string;
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Трек — LineString с массивом координат; высота — третье число в паре
    // [lng, lat, ele]. Порог достоверности тот же, что у движка рельефа:
    // считать профиль по редким высотам нельзя.
    const { rows } = await pool.query<CoverageRow>(
      `WITH t AS (
         SELECT
           COALESCE(geometry->>'source', 'неизвестно') AS source,
           CASE
             WHEN jsonb_typeof(geometry->'coordinates') = 'array'
               THEN jsonb_array_length(geometry->'coordinates')
             ELSE 0
           END AS n,
           CASE
             WHEN jsonb_typeof(geometry->'coordinates') = 'array' THEN (
               SELECT count(*)
               FROM jsonb_array_elements(geometry->'coordinates') AS c
               WHERE jsonb_typeof(c) = 'array'
                 AND jsonb_array_length(c) >= 3
                 AND (c->>2) IS NOT NULL
             )
             ELSE 0
           END AS n_ele
         FROM kamchatka_routes
         WHERE geometry IS NOT NULL
       )
       SELECT
         source,
         count(*)::text                                              AS routes,
         count(*) FILTER (WHERE n >= 2)::text                        AS with_track,
         count(*) FILTER (WHERE n >= 2 AND n_ele::float / n >= $1)::text AS with_elevation,
         COALESCE(sum(n), 0)::text                                   AS points_total,
         COALESCE(sum(n_ele), 0)::text                               AS points_with_ele
       FROM t
       GROUP BY source
       ORDER BY count(*) DESC`,
      [MIN_ELEVATION_COVERAGE],
    );

    const num = (v: string) => Number(v) || 0;
    const bySource = rows.map(r => ({
      source: r.source,
      routes: num(r.routes),
      withTrack: num(r.with_track),
      withElevation: num(r.with_elevation),
      pointsTotal: num(r.points_total),
      pointsWithElevation: num(r.points_with_ele),
    }));

    const total = bySource.reduce(
      (acc, s) => ({
        routes: acc.routes + s.routes,
        withTrack: acc.withTrack + s.withTrack,
        withElevation: acc.withElevation + s.withElevation,
      }),
      { routes: 0, withTrack: 0, withElevation: 0 },
    );

    return NextResponse.json({
      threshold: MIN_ELEVATION_COVERAGE,
      total,
      bySource,
      // Прямой ответ на вопрос «зажжётся ли профиль в поле».
      verdict: total.withElevation > 0
        ? `Профиль покажется на ${total.withElevation} маршрутах из ${total.routes}`
        : 'Высот нет ни на одном маршруте — профиль честно не покажется',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg.slice(0, 300) }, { status: 500 });
  }
}
