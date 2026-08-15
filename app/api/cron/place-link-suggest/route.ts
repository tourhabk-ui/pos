/**
 * GET /api/cron/place-link-suggest — кандидаты в маршруты для осиротевших мест.
 *
 * Перепись (проба 60) показала: 259 из 379 живых мест стоят на витрине без
 * единого живого маршрута — 45 «потеряли» их вместе со скрытыми паутинами,
 * 214 не имели никогда. Подсказчик готовит МАТЕРИАЛ ДЛЯ РЕШЕНИЯ: для
 * каждого сироты — до четырёх живых маршрутов с совпадением имени и
 * расстоянием. Ничего не пишет; привязка — поимённая, POST place-link.
 *
 * scope=lost (по умолчанию) | never | all.
 * Правила подбора и стоп-слова — lib/routes/place-link.ts.
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { suggestRoutes, type RouteCandidateInput } from '@/lib/routes/place-link';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const scopeParam = request.nextUrl.searchParams.get('scope') ?? 'lost';
  const scope = ['lost', 'never', 'all'].includes(scopeParam) ? scopeParam : 'lost';
  // Подсказка для never без совпадения имени — шум: там сотни глухих сопок,
  // которым маршрута не существует. Порог отсекает их молча только для
  // never; у lost показываем всё, там каждый случай — наша потеря.
  const minScoreForNever = 0.5;

  try {
    const placesRes = await pool.query<{
      id: string; name: string; location_type: string | null;
      lat: number | null; lng: number | null; status: 'lost' | 'never';
    }>(
      `SELECT p.id::text AS id, p.name, p.location_type, p.lat, p.lng,
              CASE WHEN EXISTS (SELECT 1 FROM route_waypoints rw WHERE rw.place_id = p.id)
                   THEN 'lost' ELSE 'never' END AS status
       FROM places p
       WHERE p.is_visible = true AND p.merged_into_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM route_waypoints rw
           JOIN kamchatka_routes r ON r.id = rw.route_id
           WHERE rw.place_id = p.id
             AND r.is_visible = true AND r.merged_into_id IS NULL
         )
       ORDER BY p.name`,
    );

    const routesRes = await pool.query<{
      id: string; title: string; lat: number | null; lng: number | null;
      has_geometry: boolean; waypoint_count: number;
    }>(
      `SELECT r.id::text AS id, r.title, r.lat, r.lng,
              (r.geometry IS NOT NULL) AS has_geometry,
              (SELECT COUNT(*)::int FROM route_waypoints rw WHERE rw.route_id = r.id) AS waypoint_count
       FROM kamchatka_routes r
       WHERE r.is_visible = true AND r.merged_into_id IS NULL`,
    );

    const routes: RouteCandidateInput[] = routesRes.rows.map(r => ({
      id: r.id, title: r.title,
      lat: r.lat == null ? null : Number(r.lat),
      lng: r.lng == null ? null : Number(r.lng),
      hasGeometry: r.has_geometry, waypointCount: r.waypoint_count,
    }));

    const orphans = placesRes.rows.filter(p => scope === 'all' || p.status === scope);
    const items = orphans.map((p) => {
      const lat = p.lat == null ? null : Number(p.lat);
      const lng = p.lng == null ? null : Number(p.lng);
      let candidates = suggestRoutes({ name: p.name, lat, lng }, routes);
      if (p.status === 'never') {
        candidates = candidates.filter(c => c.nameScore >= minScoreForNever);
      }
      return {
        placeId: p.id, name: p.name, type: p.location_type ?? 'без типа',
        status: p.status, candidates,
      };
    });

    const withCandidates = items.filter(i => i.candidates.length > 0);

    return NextResponse.json({
      success: true,
      scope,
      orphans_total: orphans.length,
      with_candidates: withCandidates.length,
      without_candidates: orphans.length - withCandidates.length,
      items: withCandidates,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка подсказчика';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
