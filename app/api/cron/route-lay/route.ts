/**
 * POST /api/cron/route-lay — прокладка линии маршрута по дорожному графу.
 *
 * Партия 4 карты боли (го владельца 15.08). Для маршрутов без геометрии,
 * но с путевыми точками, линия строится A* по графу дорог и троп OSM
 * (lib/routing, миграция 760) — звеньями между соседними waypoints.
 *
 * Правила честности:
 *   - путь не нашёлся ХОТЯ БЫ для одного звена → маршрут не трогаем вовсе
 *     (частичная линия — то же враньё, что прямая миграции 168);
 *   - точка дальше max_snap_m от графа → отказ звена: тянуть линию к
 *     дальней дороге значит рисовать путь, которым не ходят;
 *   - geometry пишется ТОЛЬКО в пустоту (geometry IS NULL) и с маркером
 *     source='road_graph_astar' — track-fidelity и аудиты обязаны знать
 *     происхождение; настоящий снятый трек такая линия никогда не перетрёт;
 *   - это линия ПО ДОРОГАМ И ТРОПАМ: там, где маршрут идёт по азимуту,
 *     A* честно вернёт no_path — и это правильный отказ, не ошибка.
 *
 * Bearer CRON_SECRET. Body: { ids: string[] (1..8), dry_run default true,
 * max_snap_m default 1000 }. Сухой прогон считает всё, не пишет ничего.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { findPath, nearestNode } from '@/lib/routing/astar';
import { loadSubgraph } from '@/lib/routing/subgraph';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const BodySchema = z.object({
  dry_run: z.boolean().default(true),
  ids: z.array(z.string().min(8).max(64)).min(1).max(8),
  max_snap_m: z.number().int().min(50).max(5000).default(1000),
});

interface LegResult {
  fromWp: string; toWp: string;
  ok: boolean;
  reason?: 'no_path' | 'too_far_from_graph' | 'empty_graph';
  meters?: number; snapFromM?: number; snapToM?: number;
}

export async function POST(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let data: z.infer<typeof BodySchema>;
  try {
    data = BodySchema.parse(await request.json().catch(() => ({})));
  } catch (err) {
    const msg = err instanceof z.ZodError ? err.issues[0]?.message : 'Некорректное тело';
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }

  const results: Array<{
    id: string; title: string; ok: boolean;
    reason?: string; legs: LegResult[];
    totalKm?: number; points?: number; written?: boolean;
  }> = [];

  try {
    for (const routeId of data.ids) {
      // eslint-disable-next-line no-await-in-loop
      const wpRes = await pool.query<{ name: string; lat: number; lng: number; geometry_present: boolean; title: string }>(
        `SELECT p.name, p.lat, p.lng, (r.geometry IS NOT NULL) AS geometry_present, r.title
         FROM kamchatka_routes r
         JOIN route_waypoints rw ON rw.route_id = r.id
         JOIN places p ON p.id = rw.place_id
         WHERE r.id::text = $1 AND p.lat IS NOT NULL AND p.lng IS NOT NULL
         ORDER BY rw.position ASC NULLS LAST, p.name`,
        [routeId],
      );

      if (wpRes.rows.length < 2) {
        results.push({ id: routeId, title: wpRes.rows[0]?.title ?? '?', ok: false, reason: 'меньше двух путевых точек', legs: [] });
        continue;
      }
      if (wpRes.rows[0].geometry_present) {
        results.push({ id: routeId, title: wpRes.rows[0].title, ok: false, reason: 'геометрия уже есть — прокладка только в пустоту', legs: [] });
        continue;
      }

      const wps = wpRes.rows;
      const legs: LegResult[] = [];
      const fullLine: Array<[number, number]> = []; // [lat,lng]
      let totalM = 0;
      let failed = false;

      for (let i = 0; i < wps.length - 1 && !failed; i++) {
        const a = wps[i], b = wps[i + 1];
        // eslint-disable-next-line no-await-in-loop
        const { nodes, edges } = await loadSubgraph(a.lat, a.lng, b.lat, b.lng);
        if (nodes.size === 0 || edges.length === 0) {
          legs.push({ fromWp: a.name, toWp: b.name, ok: false, reason: 'empty_graph' });
          failed = true; break;
        }
        const start = nearestNode(nodes.values(), a.lat, a.lng);
        const goal = nearestNode(nodes.values(), b.lat, b.lng);
        if (!start || !goal || start.distance_m > data.max_snap_m || goal.distance_m > data.max_snap_m) {
          legs.push({
            fromWp: a.name, toWp: b.name, ok: false, reason: 'too_far_from_graph',
            snapFromM: start?.distance_m, snapToM: goal?.distance_m,
          });
          failed = true; break;
        }
        const path = findPath(nodes, edges, start.node.id, goal.node.id, 'foot');
        if (!path) {
          legs.push({ fromWp: a.name, toWp: b.name, ok: false, reason: 'no_path' });
          failed = true; break;
        }
        legs.push({
          fromWp: a.name, toWp: b.name, ok: true,
          meters: path.meters, snapFromM: start.distance_m, snapToM: goal.distance_m,
        });
        totalM += path.meters;
        const startIdx = fullLine.length > 0 ? 1 : 0;
        for (let j = startIdx; j < path.geometry.length; j++) fullLine.push(path.geometry[j]);
      }

      if (failed || fullLine.length < 2) {
        results.push({ id: routeId, title: wps[0].title, ok: false, reason: legs[legs.length - 1]?.reason ?? 'линия не собралась', legs });
        continue;
      }

      let written = false;
      if (!data.dry_run) {
        // [lng, lat] — порядок GeoJSON; запись только в пустоту.
        const coords = fullLine.map(([lat, lng]) => [lng, lat]);
        // eslint-disable-next-line no-await-in-loop
        const upd = await pool.query(
          `UPDATE kamchatka_routes
           SET geometry = jsonb_build_object(
                 'type', 'LineString',
                 'coordinates', $1::jsonb,
                 'source', 'road_graph_astar'
               ),
               updated_at = NOW()
           WHERE id::text = $2 AND geometry IS NULL`,
          [JSON.stringify(coords), routeId],
        );
        written = (upd.rowCount ?? 0) > 0;
      }

      results.push({
        id: routeId, title: wps[0].title, ok: true, legs,
        totalKm: Math.round(totalM / 100) / 10, points: fullLine.length, written,
      });
    }

    return NextResponse.json({
      success: true,
      dry_run: data.dry_run,
      laid: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length,
      results,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка прокладки';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
