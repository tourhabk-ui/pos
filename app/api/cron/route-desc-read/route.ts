/**
 * GET /api/cron/route-desc-read — полные описания маршрутов по списку id.
 *
 * Инструмент кампании сверки описаний («го» владельца 21.08): перепись
 * route-desc-census показывает только голову описания (240 символов), а
 * править числа в прозе по голове нельзя — легко попасть в чужое число.
 * Этот эндпоинт отдаёт текст целиком плюс факты записи, чтобы правка
 * готовилась по полному тексту.
 *
 * Для починки уехавших координат отдаёт и place_match — живое место с тем
 * же именем из реестра: чинить координату маршрута его же местом, а не
 * догадкой.
 *
 * READ-ONLY, Bearer CRON_SECRET, ids — до 25 за раз.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const ids = (request.nextUrl.searchParams.get('ids') ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 25);
  if (ids.length === 0) {
    return NextResponse.json(
      { success: false, error: 'Нужен параметр ids — список id маршрутов через запятую' },
      { status: 400 },
    );
  }

  try {
    const { rows } = await pool.query(
      `SELECT r.id::text AS id, r.title, r.description,
              r.lat::text AS lat, r.lng::text AS lng,
              r.distance_km::text AS distance_km,
              r.duration_hours::text AS duration_hours,
              r.elevation_gain_m,
              (r.geometry IS NOT NULL) AS has_line,
              r.geometry->>'source' AS line_source,
              (SELECT json_build_object('name', p.name, 'lat', p.lat::text, 'lng', p.lng::text)
               FROM places p
               WHERE p.is_visible = true AND p.merged_into_id IS NULL
                 AND p.lat IS NOT NULL AND p.lng IS NOT NULL
                 AND lower(replace(p.name, 'ё', 'е')) = lower(replace(r.title, 'ё', 'е'))
               LIMIT 1) AS place_match
       FROM kamchatka_routes r
       WHERE r.id::text = ANY($1::text[])`,
      [ids],
    );
    return NextResponse.json({
      success: true,
      probe: 'route_desc_read_v1',
      requested: ids.length,
      found: rows.length,
      items: rows,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка чтения описаний';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
