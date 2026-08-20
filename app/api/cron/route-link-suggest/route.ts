/**
 * GET /api/cron/route-link-suggest — кандидаты-места для маршрутов без точек.
 *
 * Этап 1 плана владельца 20.08: 241 живой маршрут стоит без единой живой
 * путевой точки — значит не связан с местами, не проходит черту навигации
 * и не виден с карточек мест. Подсказчик готовит МАТЕРИАЛ ДЛЯ РЕШЕНИЯ:
 * для каждого такого маршрута — до четырёх живых мест с совпадением имени
 * и расстоянием. Ничего не пишет; привязка — поимённая, POST place-link,
 * партиями не больше 10.
 *
 * Направление обратное place-link-suggest (там сироты-МЕСТА ищут маршруты),
 * правила те же — lib/routes/place-link (suggestPlaces): имя весит больше
 * близости, родовые слова не опознают ничего.
 *
 * Кандидат с nameScore >= min_score (по умолчанию 0.5) — уверенная корзина:
 * маршрут называет место, улика происхождения есть, род связи waypoint.
 * Ниже порога — спорная корзина на глаза человеку. Совсем без кандидатов —
 * счётчиком: это очередь на этап 2 (линия) или уборку.
 *
 * Bearer CRON_SECRET. Параметры: min_score (0..1), offset, limit (окно
 * выдачи — целиком 241 маршрут в лог пробы не влезает).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { suggestPlaces, type PlaceCandidateInput } from '@/lib/routes/place-link';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const rawScore = Number(sp.get('min_score') ?? '0.5');
  const minScore = Number.isFinite(rawScore) ? Math.min(Math.max(rawScore, 0), 1) : 0.5;
  const rawOffset = parseInt(sp.get('offset') ?? '0', 10);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  const rawLimit = parseInt(sp.get('limit') ?? '40', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 40;

  try {
    const routesRes = await pool.query<{
      id: string; title: string; lat: number | null; lng: number | null;
      has_geometry: boolean; geometry_source: string | null;
    }>(
      `SELECT r.id::text AS id, r.title, r.lat, r.lng,
              (r.geometry IS NOT NULL) AS has_geometry,
              r.geometry->>'source' AS geometry_source
       FROM kamchatka_routes r
       WHERE r.is_visible = true AND r.merged_into_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM route_waypoints rw
           JOIN places p ON p.id = rw.place_id
           WHERE rw.route_id = r.id
             AND p.is_visible = true AND p.merged_into_id IS NULL
         )
       ORDER BY r.title`,
    );

    const placesRes = await pool.query<{
      id: string; name: string; location_type: string | null;
      lat: number | null; lng: number | null;
    }>(
      `SELECT p.id::text AS id, p.name, p.location_type, p.lat, p.lng
       FROM places p
       WHERE p.is_visible = true AND p.merged_into_id IS NULL`,
    );

    const places: PlaceCandidateInput[] = placesRes.rows.map(p => ({
      id: p.id, name: p.name, locationType: p.location_type,
      lat: p.lat == null ? null : Number(p.lat),
      lng: p.lng == null ? null : Number(p.lng),
    }));

    const items = routesRes.rows.map((r) => {
      const candidates = suggestPlaces(
        { title: r.title, lat: r.lat == null ? null : Number(r.lat), lng: r.lng == null ? null : Number(r.lng) },
        places,
      );
      const confident = candidates.filter(c => c.nameScore >= minScore);
      return {
        routeId: r.id, title: r.title,
        hasGeometry: r.has_geometry, geometrySource: r.geometry_source,
        confident,
        review: candidates.filter(c => c.nameScore > 0 && c.nameScore < minScore),
      };
    });

    const withConfident = items.filter(i => i.confident.length > 0);
    const reviewOnly = items.filter(i => i.confident.length === 0 && i.review.length > 0);
    const none = items.length - withConfident.length - reviewOnly.length;

    return NextResponse.json({
      success: true,
      // v2 — маркер деплоя пробы 104 (боевые партии place-link): запуск,
      // который сам пушит в main, обязан поднимать маркер — иначе POST
      // может попасть в контейнер, умирающий под пересборкой (урок run 11).
      probe: 'route_link_suggest_v2',
      min_score: minScore,
      routes_no_waypoints_total: items.length,
      with_confident: withConfident.length,
      review_only: reviewOnly.length,
      without_candidates: none,
      window: { offset, limit },
      items: withConfident.slice(offset, offset + limit),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка подсказчика маршрутов';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
