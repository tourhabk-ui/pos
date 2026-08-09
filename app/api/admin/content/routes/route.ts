import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { requireAdmin } from '@/lib/auth/middleware';
import type { TotalRow } from '@/lib/types/db-rows';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/content/routes
 * Список маршрутов из agent_route_knowledge с поиском, фильтром категории и видимости.
 */
export async function GET(request: NextRequest) {
  try {
    const adminOrResponse = await requireAdmin(request);
    if (adminOrResponse instanceof NextResponse) return adminOrResponse;

    const { searchParams } = new URL(request.url);
    const category   = searchParams.get('category');
    const search     = searchParams.get('search');
    const visibility = searchParams.get('visibility'); // 'visible' | 'hidden' | null
    // Вид записи: представление объединяет места и маршруты, и в общем списке
    // их не различить — владелец 09.08 хотел посмотреть именно маршруты.
    const kind       = searchParams.get('kind');       // 'route' | 'place' | null
    // Только маршруты, у которых есть точки: без них маршрут нельзя ни пройти,
    // ни показать в поле (§4.1 — связь через route_waypoints).
    const withWaypoints = searchParams.get('withWaypoints') === '1';
    const page       = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
    const limit      = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? '30', 10)));
    const offset     = (page - 1) * limit;

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let idx = 1;

    if (category) {
      conditions.push(`category = $${idx++}`);
      params.push(category);
    }
    if (search) {
      conditions.push(`title ILIKE $${idx++}`);
      params.push(`%${search}%`);
    }
    if (visibility === 'visible') conditions.push('is_visible = TRUE');
    else if (visibility === 'hidden') conditions.push('is_visible = FALSE');
    if (kind === 'route' || kind === 'place') {
      conditions.push(`kind = $${idx++}`);
      params.push(kind);
    }
    if (withWaypoints) {
      // Идентификатор в представлении для маршрута — COALESCE(ark_id, id),
      // а route_waypoints ссылается на kamchatka_routes.id: сопоставляем так же,
      // иначе часть маршрутов молча выпадет из выборки.
      conditions.push(`EXISTS (
        SELECT 1 FROM kamchatka_routes r
        JOIN route_waypoints rw ON rw.route_id = r.id
        WHERE COALESCE(r.ark_id, r.id) = agent_route_knowledge.id
      )`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await query<TotalRow>(
      `SELECT COUNT(*) AS total FROM agent_route_knowledge ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0]?.total ?? '0', 10);

    /**
     * Точки, трек и высоты считаются ПОСЛЕ отбора страницы: разбор координат
     * трека — операция по каждому элементу массива, и на всех трёхстах записях
     * она лишняя, а на тридцати незаметна.
     */
    const dataResult = await query<{
      id: string;
      title: string;
      category: string;
      source_name: string | null;
      lat: string | null;
      lng: string | null;
      is_visible: boolean;
      created_at: Date;
      kind: string;
      wp_count: string | null;
      track_points: string | null;
      ele_points: string | null;
      geom_source: string | null;
    }>(
      `WITH page AS (
         SELECT id, title, category, source_name, lat, lng, is_visible, created_at, kind
         FROM agent_route_knowledge
         ${where}
         ORDER BY is_visible DESC, category ASC, title ASC
         LIMIT $${idx++} OFFSET $${idx++}
       )
       SELECT page.*, kr.wp_count, kr.track_points, kr.ele_points, kr.geom_source
       FROM page
       LEFT JOIN LATERAL (
         SELECT
           (SELECT count(*) FROM route_waypoints rw WHERE rw.route_id = r.id) AS wp_count,
           CASE
             WHEN jsonb_typeof(r.geometry->'coordinates') = 'array'
               THEN jsonb_array_length(r.geometry->'coordinates')
             ELSE 0
           END AS track_points,
           CASE
             WHEN jsonb_typeof(r.geometry->'coordinates') = 'array' THEN (
               SELECT count(*) FROM jsonb_array_elements(r.geometry->'coordinates') AS c
               WHERE jsonb_typeof(c) = 'array'
                 AND jsonb_array_length(c) >= 3
                 AND (c->>2) IS NOT NULL
             )
             ELSE 0
           END AS ele_points,
           r.geometry->>'source' AS geom_source
         FROM kamchatka_routes r
         WHERE page.kind = 'route' AND COALESCE(r.ark_id, r.id) = page.id
         LIMIT 1
       ) kr ON TRUE`,
      [...params, limit, offset]
    );

    return NextResponse.json({
      success: true,
      data: dataResult.rows.map(r => ({
        id:         r.id,
        title:      r.title,
        category:   r.category,
        sourceName: r.source_name,
        hasCoords:  r.lat != null && r.lng != null,
        isVisible:  r.is_visible,
        createdAt:  r.created_at,
        kind:         r.kind,
        waypoints:    r.wp_count != null ? Number(r.wp_count) : null,
        trackPoints:  r.track_points != null ? Number(r.track_points) : null,
        // Высоты в треке — по ним решается, покажется ли профиль в поле.
        elevationPoints: r.ele_points != null ? Number(r.ele_points) : null,
        geometrySource:  r.geom_source,
      })),
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Ошибка загрузки маршрутов' },
      { status: 500 }
    );
  }
}
