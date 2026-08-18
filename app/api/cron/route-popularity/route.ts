/**
 * GET /api/cron/route-popularity?secret=<CRON_SECRET>[&days=90][&limit=30]
 *
 * Список ядра: что люди открывают чаще всего — и в каком эти записи состоянии.
 *
 * Владелец 18.08, после ночи разбора: «я уже не знаю, как навести порядок».
 * Порядок в четырёхстах записях разом не наводится, и попытка чистить всё
 * подряд — то, из-за чего работа кажется бесконечной. Решение 17.08: сорок
 * проверенных маршрутов честнее четырёхсот. Значит нужен не список всего, а
 * список ЯДРА — что размечать в первую очередь.
 *
 * Порядок задаёт спрос, а не алфавит: время, потраченное на маршрут, который
 * никто не открывает, — потерянное время, пока самый ходовой продолжает
 * отказываться вести.
 *
 * READ-ONLY. Персональных данных нет: page_views хранит суточный хэш
 * посетителя, сырых IP и User-Agent там нет по построению (152-ФЗ,
 * lib/analytics/visitor-hash).
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { pool } from '@/lib/db-pool';
import { routeNavigability } from '@/lib/routes/navigability';
import { detectTravelMode } from '@/lib/routes/travel-mode';
import { asLinkKind, isPathPoint } from '@/lib/routes/link-kind';
import { geometryToTrack } from '@/lib/routes/geometry-audit';
import { whatIsMissing, byDemand, type CoreCandidate, type DemandRow } from '@/lib/routes/popularity';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * Версия формы ответа — отдаётся и в теле 401, чтобы прогон дожидался своего
 * кода, а не цифр прежнего контейнера.
 *
 *   1 — спрос по просмотрам, турам и броням рядом с состоянием записи
 */
export const POPULARITY_VERSION = 1;

interface ViewRow { id: string; views: string; visitors: string }
interface RouteRow {
  id: string; title: string | null; geometry: unknown;
  waypoints: string; kinds: string[] | null;
  tours: string; bookings: string;
}
interface PlaceRow { id: string; name: string | null; location_type: string | null; routes: string }

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized', v: POPULARITY_VERSION }, { status: 401 });
  }

  const rawDays = parseInt(request.nextUrl.searchParams.get('days') ?? '90', 10);
  const days = Math.min(Math.max(Number.isFinite(rawDays) ? rawDays : 90, 1), 365);
  const rawLimit = parseInt(request.nextUrl.searchParams.get('limit') ?? '30', 10);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 30, 1), 100);
  const startedAt = Date.now();

  try {
    // ── Спрос: реальные открытия карточек ────────────────────────────────
    //
    // Боты исключены, иначе список возглавит поисковый робот. Идентификатор
    // берётся ВТОРЫМ сегментом пути, поэтому `/routes/<id>/prepare` считается
    // тому же маршруту: человек, дошедший до подготовки, интересовался им
    // сильнее, а не меньше.
    const viewsOf = async (kind: 'routes' | 'places'): Promise<ViewRow[]> => {
      const res = await pool.query<ViewRow>(
        `SELECT split_part(ltrim(path, '/'), '/', 2) AS id,
                COUNT(*)::text AS views,
                COUNT(DISTINCT visitor_hash)::text AS visitors
           FROM page_views
          WHERE path LIKE $1
            AND created_at > NOW() - ($2 || ' days')::interval
            AND is_bot = FALSE
          GROUP BY 1
         HAVING split_part(ltrim(path, '/'), '/', 2) <> ''
          ORDER BY COUNT(DISTINCT visitor_hash) DESC
          LIMIT 400`,
        [`/${kind}/%`, String(days)],
      );
      return res.rows;
    };

    const [routeViews, placeViews] = await Promise.all([viewsOf('routes'), viewsOf('places')]);

    // ── Маршруты: состояние рядом со спросом ─────────────────────────────
    const routeIds = routeViews.map((v) => v.id);
    let routes: RouteRow[] = [];
    if (routeIds.length > 0) {
      const res = await pool.query<RouteRow>(
        `SELECT r.id::text, r.title, r.geometry,
                COUNT(rw.id)::text AS waypoints,
                ARRAY_REMOVE(ARRAY_AGG(to_jsonb(rw)->>'link_kind'), NULL) AS kinds,
                (SELECT COUNT(*) FROM operator_tours t WHERE t.route_id = r.id)::text AS tours,
                -- Колонка называется operator_tour_id, а не tour_id: первая
                -- редакция запроса угадала имя по смыслу и получила 500 с
                -- прода. Схема живёт в миграции 040.
                (SELECT COUNT(*) FROM operator_bookings b
                  JOIN operator_tours t2 ON t2.id = b.operator_tour_id
                 WHERE t2.route_id = r.id)::text AS bookings
           FROM kamchatka_routes r
           LEFT JOIN route_waypoints rw ON rw.route_id = r.id
          WHERE r.id::text = ANY($1)
          GROUP BY r.id, r.title, r.geometry`,
        [routeIds],
      );
      routes = res.rows;
    }

    const demandOf = (v: ViewRow): Pick<DemandRow, 'views' | 'visitors'> => ({
      views: Number(v.views), visitors: Number(v.visitors),
    });

    const core: CoreCandidate[] = [];
    for (const v of routeViews) {
      const r = routes.find((x) => x.id === v.id);
      if (!r) continue;                       // просмотр записи, которой уже нет
      const track = geometryToTrack(r.geometry);
      const pairs = track.map((p: { lat: number; lng: number }) => [p.lat, p.lng] as [number, number]);
      const kinds = (r.kinds ?? []).map(asLinkKind);
      const pathPoints = kinds.length > 0 ? kinds.filter(isPathPoint).length : Number(r.waypoints);
      const nav = routeNavigability({
        grade: pairs.length >= 2 ? 'unknown' : 'points_only',
        track: pairs.length >= 2 ? pairs : null,
        // Точных координат точек здесь не запрашиваем: список отвечает на
        // вопрос «что размечать», а не «сходятся ли данные» — на второй уже
        // отвечает перепись, и повторять её тут значило бы завести вторую.
        waypoints: [],
        mode: detectTravelMode(r.title),
      });
      core.push({
        id: r.id,
        title: r.title ?? '(без названия)',
        ...demandOf(v),
        tours: Number(r.tours),
        bookings: Number(r.bookings),
        waypoints: pathPoints,
        hasLine: pairs.length >= 2,
        verdict: nav.verdict,
        missing: whatIsMissing({ verdict: nav.verdict, waypoints: pathPoints, hasLine: pairs.length >= 2 }),
      });
    }
    core.sort(byDemand);

    // ── Места: спрос и сколько маршрутов через них проходит ──────────────
    const placeIds = placeViews.map((v) => v.id);
    let places: PlaceRow[] = [];
    if (placeIds.length > 0) {
      const res = await pool.query<PlaceRow>(
        `SELECT p.id::text, p.name, p.location_type,
                (SELECT COUNT(*) FROM route_waypoints rw WHERE rw.place_id = p.id)::text AS routes
           FROM places p
          WHERE p.id::text = ANY($1)`,
        [placeIds],
      );
      places = res.rows;
    }
    const topPlaces = placeViews
      .map((v) => {
        const p = places.find((x) => x.id === v.id);
        if (!p) return null;
        return {
          id: p.id,
          title: p.name ?? '(без названия)',
          type: p.location_type,
          ...demandOf(v),
          routes: Number(p.routes),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return NextResponse.json({
      success: true,
      v: POPULARITY_VERSION,
      window_days: days,
      // Сколько просмотров вообще есть: пустая таблица читалась бы как «людям
      // ничего не интересно», хотя означает «счётчик не пишет».
      route_page_views: routeViews.reduce((s, v) => s + Number(v.views), 0),
      place_page_views: placeViews.reduce((s, v) => s + Number(v.views), 0),
      routes_seen: routeViews.length,
      places_seen: placeViews.length,
      /** Сколько из просмотренных маршрутов НЕ пригодны — размер работы. */
      core_needs_work: core.filter((c) => c.missing !== null).length,
      core: core.slice(0, limit),
      places: topPlaces.slice(0, limit),
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Список не собран' },
      { status: 500 },
    );
  }
}
