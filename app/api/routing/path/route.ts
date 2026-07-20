/**
 * GET /api/routing/path
 *
 * Свой роутер (Этап 2): путь по дорожному графу Камчатки от точки А
 * к точке Б. Используется планированием маршрута — сегмент «от меня
 * до старта тропы».
 *
 * ?from_lat&from_lng&to_lat&to_lng&mode=car|foot
 *
 * Ответ 200 всегда (полевой UI не должен падать):
 *   ok:true  → { distance_m, duration_s, geometry: [[lat,lng],...],
 *               start_snap_m, end_snap_m, mode }
 *   ok:false → { reason: 'empty_graph' | 'no_path' | 'too_far_from_road' }
 *
 * snap-дистанции — честность: от точки пользователя до ближайшей дороги
 * может быть далеко, UI обязан это показать, а не рисовать враньё.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { findPath, nearestNode } from '@/lib/routing/astar';
import { loadSubgraph } from '@/lib/routing/subgraph';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Камчатский край (с запасом): не считаем маршруты в Магадан
const QuerySchema = z.object({
  from_lat: z.coerce.number().min(50).max(63),
  from_lng: z.coerce.number().min(154).max(168),
  to_lat: z.coerce.number().min(50).max(63),
  to_lng: z.coerce.number().min(154).max(168),
  mode: z.enum(['car', 'foot']).default('car'),
});

// Дальше этого от дороги — сегмент подъезда честно не строим
const MAX_SNAP_M = 5_000;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const parsed = QuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.errors[0]?.message ?? 'Ошибка параметров' },
      { status: 400 },
    );
  }
  const q = parsed.data;

  try {
    const { nodes, edges } = await loadSubgraph(q.from_lat, q.from_lng, q.to_lat, q.to_lng);
    if (nodes.size === 0 || edges.length === 0) {
      return NextResponse.json({ ok: false, reason: 'empty_graph' });
    }

    const start = nearestNode(nodes.values(), q.from_lat, q.from_lng);
    const goal = nearestNode(nodes.values(), q.to_lat, q.to_lng);
    if (!start || !goal) {
      return NextResponse.json({ ok: false, reason: 'empty_graph' });
    }
    if (start.distance_m > MAX_SNAP_M || goal.distance_m > MAX_SNAP_M) {
      return NextResponse.json({
        ok: false,
        reason: 'too_far_from_road',
        start_snap_m: start.distance_m,
        end_snap_m: goal.distance_m,
      });
    }

    const route = findPath(nodes, edges, start.node.id, goal.node.id, q.mode);
    if (!route) {
      return NextResponse.json({ ok: false, reason: 'no_path' });
    }

    return NextResponse.json({
      ok: true,
      mode: q.mode,
      distance_m: route.meters,
      duration_s: route.seconds,
      geometry: route.geometry,
      start_snap_m: start.distance_m,
      end_snap_m: goal.distance_m,
    });
  } catch (e) {
    // Ошибка БД/перегруз подграфа → честный ok:false, не 500 в полевом UI
    return NextResponse.json({
      ok: false,
      reason: 'error',
      error: e instanceof Error ? e.message : 'internal',
    });
  }
}
