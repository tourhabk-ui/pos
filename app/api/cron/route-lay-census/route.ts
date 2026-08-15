/**
 * GET /api/cron/route-lay-census — кандидаты на прокладку линии по графу.
 *
 * Партия 4 карты боли маршрутов (го владельца 15.08): 120 видимых маршрутов
 * стоят в каталоге без геометрии. У части из них есть waypoints — для них
 * линию можно ПРОЛОЖИТЬ по дорожному графу (A*, миграция 760), а не рисовать
 * прямыми, как делала миграция 168.
 *
 * Перепись возвращает видимые маршруты без geometry с ≥2 путевыми точками:
 * id, счёт точек, разлёт (span) — по нему видно, кто компактный кандидат,
 * а кто паутина. READ-ONLY, Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const KM_PER_DEG_LAT = 111.32;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { rows } = await pool.query<{
      id: string; title: string; wp_count: number;
      min_lat: number; max_lat: number; min_lng: number; max_lng: number;
    }>(
      `SELECT r.id::text AS id, r.title,
              COUNT(p.id)::int AS wp_count,
              MIN(p.lat) AS min_lat, MAX(p.lat) AS max_lat,
              MIN(p.lng) AS min_lng, MAX(p.lng) AS max_lng
       FROM kamchatka_routes r
       JOIN route_waypoints rw ON rw.route_id = r.id
       JOIN places p ON p.id = rw.place_id
       WHERE r.geometry IS NULL
         AND r.is_visible = true
         AND r.merged_into_id IS NULL
         AND p.lat IS NOT NULL AND p.lng IS NOT NULL
       GROUP BY r.id, r.title
       HAVING COUNT(p.id) >= 2
       ORDER BY COUNT(p.id) DESC, r.title`,
    );

    const candidates = rows.map((r) => {
      const midLat = (r.min_lat + r.max_lat) / 2;
      const spanKm = Math.round(Math.hypot(
        (r.max_lat - r.min_lat) * KM_PER_DEG_LAT,
        (r.max_lng - r.min_lng) * KM_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180),
      ) * 10) / 10;
      return { id: r.id, title: r.title, wpCount: r.wp_count, spanKm };
    });

    return NextResponse.json({
      success: true,
      total: candidates.length,
      compact: candidates.filter(c => c.spanKm <= 60).length,
      candidates,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка переписи';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
