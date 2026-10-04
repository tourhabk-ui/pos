/**
 * GET /api/cron/link-kind-name-census — места «рядом», которых маршрут НАЗЫВАЕТ.
 *
 * Владелец 03–04.10 трижды наткнулся на одно и то же: «Гора Замок»,
 * «Вулкан Козельский», «Скалы Три Брата», «Халактырский пляж» — маршрут носит
 * имя места, а место числится при нём «рядом» (связь миграции 167, «в 15 км
 * от центра»). Следствия видны туристу: у маршрута нет точек пути — поле ведёт
 * на начало импортного трека, а не к цели; фото места маршруту недоступно.
 *
 * Улика рода — имя, как в разметке 874 и в `place-link` (nameMatchScore):
 * точка пути назначается потому, что маршрут её НАЗЫВАЕТ, а не потому, что
 * она рядом. Расстояние уликой НЕ служит (§4.1) — оно отдаётся для глаз.
 *
 * READ-ONLY. Ни UPDATE, ни INSERT ни при каком аргументе: правка — отдельной
 * миграцией по этому списку. Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { nameMatchScore, significantTokens, distanceKm } from '@/lib/routes/place-link';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface Row {
  route_id: string; route_title: string; place_id: string; place_name: string;
  place_lat: number | null; place_lng: number | null; route_lat: number | null; route_lng: number | null;
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { rows } = await pool.query<Row>(
      `SELECT kr.id::text AS route_id, kr.title AS route_title,
              p.id::text AS place_id, p.name AS place_name,
              p.lat::float8 AS place_lat, p.lng::float8 AS place_lng,
              kr.lat::float8 AS route_lat, kr.lng::float8 AS route_lng
         FROM route_waypoints rw
         JOIN kamchatka_routes kr ON kr.id::text = rw.route_id::text
         JOIN places p ON p.id::text = rw.place_id::text
        WHERE to_jsonb(rw)->>'link_kind' = 'nearby'
          AND kr.is_visible = TRUE AND kr.merged_into_id IS NULL
          AND p.is_visible = TRUE AND p.merged_into_id IS NULL`,
    );

    const items = rows
      .map(r => ({
        ...r,
        score: nameMatchScore(r.place_name, r.route_title),
        tokens: significantTokens(r.place_name).length,
        km: r.place_lat != null && r.place_lng != null && r.route_lat != null && r.route_lng != null
          ? Math.round(distanceKm(r.place_lat, r.place_lng, r.route_lat, r.route_lng) * 10) / 10
          : null,
      }))
      .filter(r => r.score >= 1)
      .sort((a, b) => a.route_title.localeCompare(b.route_title, 'ru'));

    return NextResponse.json({
      success: true,
      nearby_pairs_total: rows.length,
      named_total: items.length,
      routes_affected: new Set(items.map(i => i.route_id)).size,
      items: items.map(i => ({
        route_id: i.route_id, route: i.route_title,
        place_id: i.place_id, place: i.place_name,
        score: i.score, tokens: i.tokens, km: i.km,
      })),
    });
  } catch (err) {
    const e = err as Error & { code?: string };
    console.error('[link-kind-name-census] запрос упал', { sqlstate: e?.code, message: e?.message });
    return NextResponse.json({ success: false, error: e?.message ?? 'Ошибка переписи' }, { status: 502 });
  }
}
