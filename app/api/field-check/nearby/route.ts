/**
 * GET /api/field-check/nearby?lat=&lng=&radius_km= — что платформа знает
 * о местах и маршрутах вокруг проверяющего.
 *
 * Форма полевой проверки (владелец 21.08). Человек стоит на месте и видит
 * НАШУ запись: координату, дистанцию, род линии, начало описания. Дальше
 * он говорит, сходится это с землёй или нет.
 *
 * Показывается ровно то, что мы утверждаем, — включая честные «не знаю»
 * (дистанции нет, линии нет). Проверять нечего только там, где мы молчим.
 *
 * Публичный read-only: ссылку на форму владелец даёт кому хочет, логина
 * нет — в поле его вводить некому. Радиус ограничен, выдача ограничена.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const QuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius_km: z.coerce.number().min(0.5).max(60).default(15),
});

/**
 * Выход по МАРШРУТУ, а не из одной точки (владелец 21.08: «они собираются
 * не на одну локацию»). Центром берётся координата маршрута, радиус —
 * такой, чтобы накрыть его путевые точки: выход готовится дома, где есть
 * сеть, и в поле список уже лежит на телефоне.
 */
async function centerFromRoute(routeId: string): Promise<{ lat: number; lng: number; radiusKm: number } | null> {
  const { rows } = await pool.query<{ lat: number | null; lng: number | null; span_km: number | null }>(
    `SELECT r.lat::float8 AS lat, r.lng::float8 AS lng,
            (SELECT MAX(
               sqrt(power(111.0 * (p.lat::float8 - r.lat::float8), 2)
                  + power(67.0 * (p.lng::float8 - r.lng::float8), 2)))
             FROM route_waypoints w
             JOIN places p ON p.id = w.place_id
             WHERE w.route_id = r.id
               AND COALESCE(w.link_kind, 'unknown') <> 'nearby'
               AND p.lat IS NOT NULL AND p.lng IS NOT NULL) AS span_km
     FROM kamchatka_routes r
     WHERE r.id::text = $1 AND r.is_visible = true AND r.merged_into_id IS NULL`,
    [routeId],
  );
  const row = rows[0];
  if (!row || row.lat === null || row.lng === null) return null;
  // Точек может не быть вовсе — тогда берём разумный запас вокруг маршрута,
  // а не выдумываем протяжённость.
  const span = typeof row.span_km === 'number' && Number.isFinite(row.span_km) ? row.span_km : 0;
  return { lat: row.lat, lng: row.lng, radiusKm: Math.min(60, Math.max(8, Math.ceil(span + 5))) };
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const routeId = (sp.get('route_id') ?? '').trim();

  let lat: number, lng: number, radius_km: number;
  if (routeId) {
    let center: Awaited<ReturnType<typeof centerFromRoute>>;
    try {
      center = await centerFromRoute(routeId);
    } catch {
      return NextResponse.json({ success: false, error: 'Не удалось прочитать маршрут' }, { status: 502 });
    }
    if (!center) {
      return NextResponse.json(
        { success: false, error: 'У маршрута нет координаты — обходить его вслепую нельзя' },
        { status: 404 },
      );
    }
    lat = center.lat; lng = center.lng; radius_km = center.radiusKm;
  } else {
    const parsed = QuerySchema.safeParse({
      lat: sp.get('lat'), lng: sp.get('lng'), radius_km: sp.get('radius_km') ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'Нужны координаты: lat и lng — или route_id' },
        { status: 400 },
      );
    }
    lat = parsed.data.lat; lng = parsed.data.lng; radius_km = parsed.data.radius_km;
  }
  // Грубая рамка вокруг точки: широта ~111 км/°, долгота на 53°N ~67 км/°.
  // Точное расстояние считается ниже, рамка нужна индексу.
  const dLat = radius_km / 111;
  const dLng = radius_km / 67;

  try {
    const [places, routes] = await Promise.all([
      pool.query(
        `SELECT p.id::text AS id, p.name, p.location_type,
                p.lat::float8 AS lat, p.lng::float8 AS lng,
                LEFT(p.description, 160) AS description_head
         FROM places p
         WHERE p.is_visible = true AND p.merged_into_id IS NULL
           AND p.lat IS NOT NULL AND p.lng IS NOT NULL
           AND p.lat::float8 BETWEEN $1 AND $2
           AND p.lng::float8 BETWEEN $3 AND $4
         LIMIT 60`,
        [lat - dLat, lat + dLat, lng - dLng, lng + dLng],
      ),
      pool.query(
        `SELECT r.id::text AS id, r.title,
                r.lat::float8 AS lat, r.lng::float8 AS lng,
                r.distance_km::text AS distance_km,
                r.duration_hours::text AS duration_hours,
                r.difficulty,
                r.geometry->>'source' AS line_source,
                (r.geometry IS NOT NULL) AS has_line,
                LEFT(r.description, 160) AS description_head
         FROM kamchatka_routes r
         WHERE r.is_visible = true AND r.merged_into_id IS NULL
           AND r.lat IS NOT NULL AND r.lng IS NOT NULL
           AND r.lat::float8 BETWEEN $1 AND $2
           AND r.lng::float8 BETWEEN $3 AND $4
         LIMIT 60`,
        [lat - dLat, lat + dLat, lng - dLng, lng + dLng],
      ),
    ]);

    const R = 6371;
    const distKm = (aLat: number, aLng: number) => {
      const p1 = (lat * Math.PI) / 180, p2 = (aLat * Math.PI) / 180;
      const dP = ((aLat - lat) * Math.PI) / 180, dL = ((aLng - lng) * Math.PI) / 180;
      const s = Math.sin(dP / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dL / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
    };

    const items = [
      ...places.rows.map(p => ({
        kind: 'place' as const,
        id: p.id as string,
        title: p.name as string,
        subtitle: (p.location_type as string | null) ?? null,
        lat: p.lat as number, lng: p.lng as number,
        facts: [] as Array<{ label: string; value: string | null }>,
        description_head: (p.description_head as string | null) ?? null,
        away_km: Math.round(distKm(p.lat as number, p.lng as number) * 10) / 10,
      })),
      ...routes.rows.map(r => ({
        kind: 'route' as const,
        id: r.id as string,
        title: r.title as string,
        subtitle: (r.difficulty as string | null) ?? null,
        lat: r.lat as number, lng: r.lng as number,
        facts: [
          { label: 'дистанция', value: (r.distance_km as string | null) ? `${r.distance_km} км` : null },
          { label: 'время', value: (r.duration_hours as string | null) ? `${r.duration_hours} ч` : null },
          {
            label: 'линия',
            value: r.has_line
              ? `есть (${(r.line_source as string | null) ?? 'источник не записан'})`
              : null,
          },
        ],
        description_head: (r.description_head as string | null) ?? null,
        away_km: Math.round(distKm(r.lat as number, r.lng as number) * 10) / 10,
      })),
    ]
      .filter(i => i.away_km <= radius_km)
      .sort((a, b) => a.away_km - b.away_km)
      .slice(0, 60);

    return NextResponse.json({
      success: true,
      probe: 'field_check_nearby_v1',
      mode: routeId ? 'route' : 'point',
      route_id: routeId || null,
      center: { lat, lng },
      radius_km,
      total: items.length,
      items,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка выборки';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
