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
 *   ok:false → { reason, message, graph: {...} }
 *
 * snap-дистанции — честность: от точки пользователя до ближайшей дороги
 * может быть далеко, UI обязан это показать, а не рисовать враньё.
 *
 * ── Почему у отказа есть код И числа ───────────────────────────────────────
 *
 * Роутер отвечал одним `no_path` на все случаи разом. Полевая проба 11.08:
 * четыре километра по Петропавловску, на машине — `no_path`. Дороги там,
 * разумеется, есть; ответ был про наш граф, а звучал как утверждение о
 * местности. Это тот же дефект, что «0 вместо неизвестно»: отсутствие
 * результата принимает форму результата, и по нему начинают делать выводы.
 *
 * Теперь отказ говорит, какое именно из трёх разных утверждений верно —
 * дорог тут нет в графе вовсе, до дороги слишком далеко, граф рассыпан,
 * или дорога есть, но не для этого способа передвижения, — и прикладывает
 * размеры, которыми это проверяется без доступа к БД.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { findPath, nearestNode, diagnoseFailure, routableNodes } from '@/lib/routing/astar';
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
      { ok: false, error: parsed.error.issues[0]?.message ?? 'Ошибка параметров' },
      { status: 400 },
    );
  }
  const q = parsed.data;

  try {
    const { nodes, edges } = await loadSubgraph(q.from_lat, q.from_lng, q.to_lat, q.to_lng);
    const graph = { nodes: nodes.size, edges: edges.length };

    if (nodes.size === 0 || edges.length === 0) {
      return NextResponse.json({
        ok: false, reason: 'empty_graph', graph,
        message: 'Дорог в этом районе у нас в данных нет',
      });
    }

    // Привязка — только к узлам, из которых в этом режиме есть куда выйти.
    // Иначе точка садится на висячий узел (рёбра ушли за bbox), путь не
    // находится, и это выглядит как «дороги нет».
    const routable = routableNodes(edges, q.mode);
    const start = nearestNode(nodes.values(), q.from_lat, q.from_lng, routable);
    const goal = nearestNode(nodes.values(), q.to_lat, q.to_lng, routable);
    if (!start || !goal) {
      return NextResponse.json({
        ok: false, reason: 'empty_graph', graph: { ...graph, routable: routable.size },
        message: q.mode === 'car'
          ? 'Проезжих дорог в этом районе у нас в данных нет'
          : 'Дорог в этом районе у нас в данных нет',
      });
    }
    if (start.distance_m > MAX_SNAP_M || goal.distance_m > MAX_SNAP_M) {
      return NextResponse.json({
        ok: false,
        reason: 'too_far_from_road',
        graph,
        start_snap_m: start.distance_m,
        end_snap_m: goal.distance_m,
        message: 'До ближайшей дороги слишком далеко — подъезд не строим',
      });
    }

    const route = findPath(nodes, edges, start.node.id, goal.node.id, q.mode);
    if (!route) {
      const d = diagnoseFailure(edges, start.node.id, goal.node.id, q.mode);
      return NextResponse.json({
        ok: false,
        reason: d.reason,
        mode: q.mode,
        graph: { ...graph, routable: routable.size, reachable_any: d.reachable_any, reachable_mode: d.reachable_mode },
        start_snap_m: start.distance_m,
        end_snap_m: goal.distance_m,
        message: d.reason === 'mode_blocked'
          ? (q.mode === 'car'
            ? 'Дорога есть, но проехать по ней нельзя — только пешком'
            : 'Дорога есть, но пройти по ней нельзя')
          : 'Связного пути по нашим данным нет',
      });
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
