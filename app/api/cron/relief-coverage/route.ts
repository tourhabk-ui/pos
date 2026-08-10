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
import { checkRoutes, summarize, type RouteReliefRow } from '@/lib/routes/relief-sanity';

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

  /**
   * mode=sanity — сходятся ли трек и название.
   *
   * Высоты, залитые 09.08, вскрыли невидимое: маршрут «Вулкан Кроноцкий»
   * получил высоты −1..45 м при вершине 3528. Модель не ошиблась — трек
   * ведёт не туда, куда обещает название. Человек планирует выход по
   * названию, а идёт по треку; узнать о расхождении он должен здесь, а не
   * в поле.
   *
   * Живёт рядом с замером покрытия: тот же вопрос о качестве рельефа, тот
   * же секрет, отдельного эндпоинта заводить незачем.
   */
  if (req.nextUrl.searchParams.get('mode') === 'sanity') {
    try {
      const { rows } = await pool.query<{
        id: string; title: string; lat: string | null; lng: string | null;
        track_lat: string | null; track_lng: string | null;
        max_ele: string | null; min_ele: string | null;
      }>(
        `SELECT id, title, lat, lng,
                (geometry->'coordinates'->0->>1) AS track_lat,
                (geometry->'coordinates'->0->>0) AS track_lng,
                (SELECT max((c->>2)::numeric) FROM jsonb_array_elements(geometry->'coordinates') c
                  WHERE jsonb_typeof(c) = 'array' AND jsonb_array_length(c) >= 3) AS max_ele,
                (SELECT min((c->>2)::numeric) FROM jsonb_array_elements(geometry->'coordinates') c
                  WHERE jsonb_typeof(c) = 'array' AND jsonb_array_length(c) >= 3) AS min_ele
           FROM kamchatka_routes
          WHERE geometry IS NOT NULL
            AND jsonb_typeof(geometry->'coordinates') = 'array'
            AND jsonb_array_length(geometry->'coordinates') >= 2`,
      );

      const num = (v: string | null) => (v === null ? null : Number(v));
      const parsed: RouteReliefRow[] = rows.map(r => ({
        id: String(r.id),
        title: r.title,
        lat: num(r.lat), lng: num(r.lng),
        trackLat: num(r.track_lat), trackLng: num(r.track_lng),
        maxElevationM: num(r.max_ele), minElevationM: num(r.min_ele),
      }));

      const findings = checkRoutes(parsed);
      return NextResponse.json({
        mode: 'sanity',
        checked: parsed.length,
        findings,
        // Чинить автоматически нельзя: имена мест на Камчатке путаные, и
        // подгонка геометрии под название сделает ложь достовернее.
        verdict: summarize(findings, parsed.length),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ error: msg.slice(0, 300) }, { status: 500 });
    }
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
