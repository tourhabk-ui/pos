/**
 * POST /api/admin/enrich/routes
 *
 * Обогащение маршрутов:
 * - description < 300 → AI-расширение
 * - geometry IS NULL + waypoints есть → OSRM LineString
 * - equipment[] пусто → AI-список снаряжения
 * - hazards[] пусто → AI-список опасностей
 *
 * Auth: requireAdmin
 * Body: { limit?: number, field?: 'description' | 'geometry' | 'equipment' | 'all' }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { callAIFast } from '@/lib/ai/providers';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface RouteRow {
  id: string;
  title: string;
  description: string | null;
  geometry: unknown | null;
  equipment: string[] | null;
  hazards: string[] | null;
  activity_type: string | null;
  difficulty: string | null;
  distance_km: number | null;
  duration_hours: number | null;
  zone: string | null;
  season: string | null;
}

interface Waypoint {
  lat: number;
  lng: number;
  name: string;
}

async function fetchOSRMGeometry(waypoints: Waypoint[]): Promise<unknown | null> {
  if (waypoints.length < 2) return null;
  const coords = waypoints.map(w => `${w.lng},${w.lat}`).join(';');
  try {
    const res = await fetch(
      `https://router.project-osrm.org/route/v1/foot/${coords}?geometries=geojson&overview=full`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) return null;
    const data = await res.json() as { routes?: { geometry: { coordinates: [number, number][] } }[] };
    const coords2 = data.routes?.[0]?.geometry?.coordinates;
    if (!coords2?.length) return null;
    return { type: 'LineString', coordinates: coords2 };
  } catch {
    return null;
  }
}

async function enrichRouteDescription(route: RouteRow, waypoints: Waypoint[]): Promise<string> {
  const waypointNames = waypoints.map(w => w.name).filter(Boolean).join(', ');
  const prompt = `Опиши пеший маршрут Камчатки для туриста.

Название: ${route.title}
Тип активности: ${route.activity_type ?? 'треккинг'}
Сложность: ${route.difficulty ?? 'средняя'}
${route.distance_km ? `Дистанция: ${route.distance_km} км` : ''}
${route.duration_hours ? `Длительность: ${route.duration_hours} ч` : ''}
${route.zone ? `Зона: ${route.zone}` : ''}
${waypointNames ? `Ключевые точки: ${waypointNames}` : ''}
Текущее описание: ${route.description ?? '(отсутствует)'}

Напиши описание 400-600 символов: что увидит турист, чем интересен маршрут, особенности. Конкретно, без воды. Только текст.`;

  return await callAIFast([{ role: 'user', content: prompt }]);
}

async function enrichEquipment(route: RouteRow): Promise<string[]> {
  const prompt = `Составь список снаряжения для маршрута "${route.title}" (${route.activity_type ?? 'треккинг'}, сложность: ${route.difficulty ?? 'средняя'}, ${route.distance_km ? route.distance_km + ' км' : ''}).

Верни только JSON-массив строк на русском, до 8 позиций. Пример: ["трекинговые палки", "треккинговые ботинки", "аптечка", "дождевик", "термос"]. Только JSON, без пояснений.`;

  const raw = await callAIFast([{ role: 'user', content: prompt }]);
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]) as string[];
  } catch {}
  return [];
}

async function enrichHazards(route: RouteRow): Promise<string[]> {
  const prompt = `Какие опасности на маршруте "${route.title}" (${route.activity_type ?? 'треккинг'}, ${route.zone ?? 'Камчатка'})?

Верни только JSON-массив строк на русском, до 5 позиций. Пример: ["медведи", "камнепад", "ручьи без мостов", "нестабильный грунт"]. Только JSON.`;

  const raw = await callAIFast([{ role: 'user', content: prompt }]);
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]) as string[];
  } catch {}
  return [];
}

export async function POST(req: NextRequest) {
  const authResult = await requireAdmin(req);
  if (authResult instanceof NextResponse) return authResult;

  const body = await req.json().catch(() => ({}));
  const limit: number = Math.min(Number(body.limit) || 15, 30);
  const field: string = body.field || 'all';

  const whereClause = field === 'description'
    ? `(r.description IS NULL OR char_length(r.description) < 300)`
    : field === 'geometry'
    ? `r.geometry IS NULL`
    : field === 'equipment'
    ? `(r.equipment IS NULL OR array_length(r.equipment, 1) IS NULL)`
    : `(r.description IS NULL OR char_length(r.description) < 300 OR r.geometry IS NULL OR r.equipment IS NULL)`;

  const { rows } = await pool.query<RouteRow>(
    `SELECT id, title, description, geometry, equipment, hazards,
            activity_type, difficulty, distance_km, duration_hours, zone, season
     FROM kamchatka_routes
     WHERE is_visible = TRUE AND ${whereClause}
     ORDER BY updated_at ASC
     LIMIT $1`,
    [limit],
  );

  const results: { id: string; title: string; updated: string[]; error?: string }[] = [];

  for (const route of rows) {
    const updated: string[] = [];
    const updates: Record<string, unknown> = {};

    try {
      // Waypoints для геометрии
      const wpResult = await pool.query<{ lat: number; lng: number; name: string }>(
        `SELECT p.lat, p.lng, p.name
         FROM route_waypoints rw
         JOIN places p ON p.id = rw.place_id
         WHERE rw.route_id = $1
         ORDER BY rw.position ASC`,
        [route.id],
      );
      const waypoints = wpResult.rows;

      if ((field === 'all' || field === 'geometry') && !route.geometry && waypoints.length >= 2) {
        const geom = await fetchOSRMGeometry(waypoints);
        if (geom) {
          updates['geometry'] = JSON.stringify(geom);
          updated.push('geometry');
        }
      }

      if ((field === 'all' || field === 'description') && (!route.description || route.description.length < 300)) {
        updates['description'] = await enrichRouteDescription(route, waypoints);
        updated.push('description');
      }

      if ((field === 'all' || field === 'equipment') && (!route.equipment || route.equipment.length === 0)) {
        const eq = await enrichEquipment(route);
        if (eq.length > 0) {
          updates['equipment'] = `ARRAY[${eq.map(e => `'${e.replace(/'/g, "''")}'`).join(',')}]::text[]`;
          updated.push('equipment');
        }
      }

      if ((field === 'all' || field === 'hazards') && (!route.hazards || route.hazards.length === 0)) {
        const hz = await enrichHazards(route);
        if (hz.length > 0) {
          updates['hazards'] = `ARRAY[${hz.map(h => `'${h.replace(/'/g, "''")}'`).join(',')}]::text[]`;
          updated.push('hazards');
        }
      }

      if (Object.keys(updates).length > 0) {
        const regularFields: string[] = [];
        const regularValues: unknown[] = [route.id];

        for (const [k, v] of Object.entries(updates)) {
          if (typeof v === 'string' && v.startsWith('ARRAY[')) {
            // array literal — inject directly (already sanitised above)
            regularFields.push(`${k} = ${v}`);
          } else {
            regularValues.push(v);
            regularFields.push(`${k} = $${regularValues.length}`);
          }
        }

        await pool.query(
          `UPDATE kamchatka_routes SET ${regularFields.join(', ')}, updated_at = NOW() WHERE id = $1`,
          regularValues,
        );
      }

      results.push({ id: route.id, title: route.title, updated });
    } catch (err) {
      results.push({ id: route.id, title: route.title, updated, error: String(err) });
    }
  }

  return NextResponse.json({
    success: true,
    processed: rows.length,
    updated: results.filter(r => r.updated.length > 0).length,
    results,
  });
}
