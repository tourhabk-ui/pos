/**
 * lib/routing/road-graph-route.ts
 *
 * Общее ядро своего роутера (владелец 2026-07-20, миграция 760;
 * подключение к CarRouteProvider — 28.08). Вынесено из
 * `app/api/routing/path/route.ts`, а не написано заново: та же
 * последовательность решений (bbox-подграф → узлы, проходимые режимом →
 * привязка старта/финиша → отсечка дальнего снапа → A* → честная причина
 * отказа) уже один раз чинилась 11.08 — «no_path» на четыре километра по
 * Петропавловску звучал как «дорог нет», хотя дело было в графе. Второй
 * независимый список причин отказа разошёлся бы с этим при следующей
 * правке, ровно тот класс дефекта, ради которого писался §12 CLAUDE.md
 * для линий: одно правило, реализованное дважды, — это два правила.
 *
 * `/api/routing/path` теперь зовёт эту функцию и мапит результат в свой
 * прежний JSON — контракт эндпоинта не изменился. `roadGraphCarProvider`
 * (lib/on-route/road-graph-car-provider.ts) зовёт её же для произвольного
 * Origin → Destination в режиме 'car'.
 */

import {
  findPath, nearestNode, diagnoseFailure, routableNodes, nearestNodesWithin, componentIds,
  type TravelMode, type RoadNode,
} from '@/lib/routing/astar';
import { loadSubgraph } from '@/lib/routing/subgraph';

export type { TravelMode };

/** Дальше этого от дороги — подъезд честно не строим (не гоняем A* впустую). */
export const MAX_SNAP_M = 5_000;

/** Сколько ближайших узлов перебирать с каждого конца при привязке к одной компоненте. */
export const SNAP_CANDIDATES = 40;

/**
 * Насколько дальше ближайшего узла может стоять узел «той же компоненты»,
 * чтобы привязка на него считалась той же точкой, а не другой. Обрывок у
 * Паратунки — десятки метров; тропа в километр от проезжей дороги — это
 * уже ДРУГОЕ место, и там честный ответ — mode_blocked («дорога есть, но
 * проехать нельзя»), а не автопуть до случайного узла в километре.
 */
export const SNAP_SLACK_M = 300;

type Snap = { node: RoadNode; distance_m: number };

/**
 * Пара узлов старт/цель из ОДНОЙ компоненты связности с наименьшей суммой
 * привязок. Перепись 05.09 (Николаевка → Паратунка, Паратунка → Термальный):
 * ближайший к точке узел стоял на изолированном обрывке (подъезд, улица,
 * разорванная на импорте), и A* честно отвечал disconnected при живой трассе
 * в десятках метров. Навигатор в такой ситуации сажает точку на дорогу, с
 * которой можно уехать, — и это не «выдуманный путь», а выбор среди
 * настоящих узлов в том же радиусе привязки. null — ни одна пара в радиусе
 * не связана: тогда остаётся честный disconnected по ближайшим узлам.
 *
 * Кандидаты дальше «ближайший + SNAP_SLACK_M» не рассматриваются: иначе
 * тупик тропы в километре от дороги превращался бы в «ok» до узла, где
 * человека никто не ждёт.
 */
export function pickConnectedPair(
  starts: Snap[], goals: Snap[], comp: Map<number, number>, slackM = SNAP_SLACK_M,
): { start: Snap; goal: Snap } | null {
  const sLimit = (starts[0]?.distance_m ?? 0) + slackM;
  const gLimit = (goals[0]?.distance_m ?? 0) + slackM;
  let best: { start: Snap; goal: Snap } | null = null;
  let bestSum = Infinity;
  for (const s of starts) {
    if (s.distance_m > sLimit) break;
    const cs = comp.get(s.node.id);
    if (cs === undefined) continue;
    for (const g of goals) {
      if (g.distance_m > gLimit) break;
      if (comp.get(g.node.id) !== cs) continue;
      const sum = s.distance_m + g.distance_m;
      if (sum < bestSum) { bestSum = sum; best = { start: s, goal: g }; }
    }
  }
  return best;
}

interface SnappedNode {
  lat: number;
  lng: number;
  snapM: number;
}

export type RoadGraphRouteResult =
  | {
      ok: true;
      mode: TravelMode;
      distanceM: number;
      durationS: number;
      /** [[lat,lng],...] — как отдаёт findPath, НЕ GeoJSON порядок. */
      geometry: Array<[number, number]>;
      start: SnappedNode;
      goal: SnappedNode;
      graph: { nodes: number; edges: number; routable: number };
    }
  | {
      ok: false;
      reason: 'empty_graph' | 'too_far_from_road' | 'disconnected' | 'mode_blocked';
      message: string;
      graph?: { nodes: number; edges: number; routable?: number; reachable_any?: number; reachable_mode?: number };
      start?: SnappedNode;
      goal?: SnappedNode;
    };

/**
 * Путь по дорожному графу Камчатки от точки А к точке Б.
 *
 * Не бросает исключений на «пути нет» — это НОРМАЛЬНЫЙ исход с честной
 * причиной (§4.0 CLAUDE.md: третье состояние). Бросает только на настоящий
 * сбой (БД недоступна, подграф больше предохранителя lib/routing/subgraph.ts)
 * — это решает вызывающий (эндпоинт отвечает `ok:false, reason:'error'`,
 * провайдер — `status:'error', retryable:true`).
 */
export async function roadGraphRoute(
  fromLat: number, fromLng: number, toLat: number, toLng: number, mode: TravelMode,
): Promise<RoadGraphRouteResult> {
  const { nodes, edges } = await loadSubgraph(fromLat, fromLng, toLat, toLng);
  const graph = { nodes: nodes.size, edges: edges.length };

  if (nodes.size === 0 || edges.length === 0) {
    return {
      ok: false, reason: 'empty_graph', graph,
      message: 'Дорог в этом районе у нас в данных нет',
    };
  }

  // Привязка — только к узлам, из которых в этом режиме есть куда выйти.
  // Иначе точка садится на висячий узел (рёбра ушли за bbox), путь не
  // находится, и это выглядит как «дороги нет».
  const routable = routableNodes(edges, mode);
  const nearestStart = nearestNode(nodes.values(), fromLat, fromLng, routable);
  const nearestGoal = nearestNode(nodes.values(), toLat, toLng, routable);
  // Привязка к одной компоненте (см. pickConnectedPair): среди узлов в
  // радиусе MAX_SNAP_M с обоих концов — ближайшая СВЯЗАННАЯ пара. Нет такой —
  // ближайшие узлы как есть, и отказ ниже называет причину честно.
  const connected = pickConnectedPair(
    nearestNodesWithin(nodes.values(), fromLat, fromLng, routable, MAX_SNAP_M, SNAP_CANDIDATES),
    nearestNodesWithin(nodes.values(), toLat, toLng, routable, MAX_SNAP_M, SNAP_CANDIDATES),
    componentIds(edges, mode),
  );
  const start = connected?.start ?? nearestStart;
  const goal = connected?.goal ?? nearestGoal;
  if (!start || !goal) {
    return {
      ok: false, reason: 'empty_graph', graph: { ...graph, routable: routable.size },
      message: mode === 'car'
        ? 'Проезжих дорог в этом районе у нас в данных нет'
        : 'Дорог в этом районе у нас в данных нет',
    };
  }
  if (start.distance_m > MAX_SNAP_M || goal.distance_m > MAX_SNAP_M) {
    return {
      ok: false,
      reason: 'too_far_from_road',
      graph,
      start: { lat: start.node.lat, lng: start.node.lng, snapM: start.distance_m },
      goal: { lat: goal.node.lat, lng: goal.node.lng, snapM: goal.distance_m },
      message: 'До ближайшей дороги слишком далеко — подъезд не строим',
    };
  }

  const route = findPath(nodes, edges, start.node.id, goal.node.id, mode);
  if (!route) {
    const d = diagnoseFailure(edges, start.node.id, goal.node.id, mode);
    return {
      ok: false,
      reason: d.reason,
      graph: { ...graph, routable: routable.size, reachable_any: d.reachable_any, reachable_mode: d.reachable_mode },
      start: { lat: start.node.lat, lng: start.node.lng, snapM: start.distance_m },
      goal: { lat: goal.node.lat, lng: goal.node.lng, snapM: goal.distance_m },
      message: d.reason === 'mode_blocked'
        ? (mode === 'car'
          ? 'Дорога есть, но проехать по ней нельзя — только пешком'
          : 'Дорога есть, но пройти по ней нельзя')
        : 'Связного пути по нашим данным нет',
    };
  }

  return {
    ok: true,
    mode,
    distanceM: route.meters,
    durationS: route.seconds,
    geometry: route.geometry,
    start: { lat: start.node.lat, lng: start.node.lng, snapM: start.distance_m },
    goal: { lat: goal.node.lat, lng: goal.node.lng, snapM: goal.distance_m },
    graph: { ...graph, routable: routable.size },
  };
}
