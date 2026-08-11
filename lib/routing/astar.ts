/**
 * lib/routing/astar.ts
 *
 * Ядро роутера: A* по дорожному графу Камчатки (миграция 760).
 * Чистый модуль без БД/сети — покрыт юнит-тестами. Подграф загружает
 * lib/routing/subgraph.ts, HTTP-обвязка — /api/routing/path.
 *
 * Модель скоростей — стартовые оценки под камчатские дороги (грунтовки
 * и track — норма жизни), калибровать по полевым прогонам.
 */

export interface RoadNode {
  id: number;
  lat: number;
  lng: number;
}

export interface RoadEdge {
  from: number;
  to: number;
  length_m: number;
  highway: string;
  surface: string | null;
  /** Полилиния сегмента [[lat,lng],...] — от from к to. */
  geometry: Array<[number, number]>;
}

export type TravelMode = 'car' | 'foot';

// км/ч по классам highway для авто; null = непроезжаемо машиной
const CAR_SPEED_KMH: Record<string, number | null> = {
  motorway: 90, trunk: 80, primary: 70, secondary: 60, tertiary: 50,
  unclassified: 40, residential: 30, living_street: 15, service: 20,
  road: 40, track: 25,
  path: null, footway: null, bridleway: null, cycleway: null,
};

// Грунт/гравий замедляют машину; пешехода — нет
const CAR_SURFACE_FACTOR: Record<string, number> = {
  gravel: 0.7, ground: 0.6, dirt: 0.6, sand: 0.5, grass: 0.5,
  unpaved: 0.7, compacted: 0.8, fine_gravel: 0.8, pebblestone: 0.7, mud: 0.4,
};

const FOOT_SPEED_KMH = 4.5;

/** Стоимость ребра в секундах для режима; Infinity = непроходимо. */
export function edgeCostSeconds(edge: Pick<RoadEdge, 'length_m' | 'highway' | 'surface'>, mode: TravelMode): number {
  if (mode === 'foot') {
    return (edge.length_m / 1000 / FOOT_SPEED_KMH) * 3600;
  }
  const base = CAR_SPEED_KMH[edge.highway];
  if (base == null) return Infinity;
  const factor = edge.surface ? (CAR_SURFACE_FACTOR[edge.surface] ?? 1) : 1;
  return (edge.length_m / 1000 / (base * factor)) * 3600;
}

const EARTH_R = 6371000;
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Ближайший узел графа к точке (линейный скан — подграф небольшой).
 *
 * `allowed` — узлы, которые вообще имеет смысл рассматривать. Без него
 * привязка садится на ЛЮБОЙ ближайший узел, в том числе на такой, из
 * которого в этом режиме не выйти: подграф грузится по bbox, и рёбра с
 * концом за его границей отброшены, так что висячие узлы там есть всегда.
 * Сесть на такой узел значит гарантированно не найти пути, стоя в двадцати
 * метрах от настоящего перекрёстка, — и списать это на «дороги нет».
 */
export function nearestNode(
  nodes: Iterable<RoadNode>, lat: number, lng: number, allowed?: Set<number>,
): { node: RoadNode; distance_m: number } | null {
  let best: RoadNode | null = null;
  let bestD = Infinity;
  for (const n of nodes) {
    if (allowed && !allowed.has(n.id)) continue;
    const d = haversineM(lat, lng, n.lat, n.lng);
    if (d < bestD) { bestD = d; best = n; }
  }
  return best ? { node: best, distance_m: Math.round(bestD) } : null;
}

/** Узлы, у которых есть хотя бы одно ребро, проходимое этим режимом. */
export function routableNodes(edges: RoadEdge[], mode: TravelMode): Set<number> {
  const ids = new Set<number>();
  for (const e of edges) {
    if (!Number.isFinite(edgeCostSeconds(e, mode))) continue;
    ids.add(e.from);
    ids.add(e.to);
  }
  return ids;
}

// ── Мини-куча (бинарная) для очереди A* ──────────────────────────────────────
class MinHeap {
  private a: Array<{ id: number; f: number }> = [];
  get size(): number { return this.a.length; }
  push(id: number, f: number): void {
    this.a.push({ id, f });
    let i = this.a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.a[p].f <= this.a[i].f) break;
      [this.a[p], this.a[i]] = [this.a[i], this.a[p]];
      i = p;
    }
  }
  pop(): { id: number; f: number } | undefined {
    const top = this.a[0];
    const last = this.a.pop();
    if (this.a.length > 0 && last) {
      this.a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.a.length && this.a[l].f < this.a[m].f) m = l;
        if (r < this.a.length && this.a[r].f < this.a[m].f) m = r;
        if (m === i) break;
        [this.a[m], this.a[i]] = [this.a[i], this.a[m]];
        i = m;
      }
    }
    return top;
  }
}

export interface RouteResult {
  /** Узлы пути от старта к финишу. */
  path: number[];
  seconds: number;
  meters: number;
  /** Склеенная полилиния пути [[lat,lng],...]. */
  geometry: Array<[number, number]>;
}

/** Списки смежности по рёбрам; рёбра двунаправленные. */
function adjacency(edges: RoadEdge[]): Map<number, Array<{ edge: RoadEdge; to: number; reversed: boolean }>> {
  const adj = new Map<number, Array<{ edge: RoadEdge; to: number; reversed: boolean }>>();
  const add = (from: number, to: number, edge: RoadEdge, reversed: boolean) => {
    let list = adj.get(from);
    if (!list) { list = []; adj.set(from, list); }
    list.push({ edge, to, reversed });
  };
  for (const e of edges) {
    add(e.from, e.to, e, false);
    add(e.to, e.from, e, true);
  }
  return adj;
}

/**
 * Узлы, достижимые из startId.
 *
 * `mode === null` — связность по данным как таковая: есть ли вообще
 * нарисованный путь. `mode` задан — связность для этого способа
 * передвижения, с учётом непроходимых рёбер.
 *
 * Различие не академическое. «Дороги в ту сторону у нас нет» и «дорога
 * есть, но машина по ней не пройдёт» — разные ответы человеку, и лечатся
 * они разным: первое — импортом данных, второе — выбором режима.
 */
export function componentFrom(edges: RoadEdge[], startId: number, mode: TravelMode | null = null): Set<number> {
  const adj = adjacency(edges);
  const seen = new Set<number>([startId]);
  const stack = [startId];
  while (stack.length > 0) {
    const cur = stack.pop() as number;
    for (const { edge, to } of adj.get(cur) ?? []) {
      if (seen.has(to)) continue;
      if (mode !== null && !Number.isFinite(edgeCostSeconds(edge, mode))) continue;
      seen.add(to);
      stack.push(to);
    }
  }
  return seen;
}

/**
 * Почему пути нет — код и числа, которыми это можно проверить.
 *
 * `findPath` возвращает `null`, и голое «пути нет» одинаково звучит и
 * когда дороги действительно нет, и когда наш граф рассыпан на куски.
 * Это ровно то, чего платформа не должна себе позволять: отсутствие
 * результата в форме результата. Здесь оно разбирается на два разных
 * утверждения, и каждое подкреплено размером компоненты.
 */
export type PathFailure = 'disconnected' | 'mode_blocked';

export interface PathDiagnosis {
  reason: PathFailure;
  /** Узлов достижимо из старта по данным (без учёта режима). */
  reachable_any: number;
  /** Узлов достижимо из старта именно этим режимом. */
  reachable_mode: number;
}

export function diagnoseFailure(
  edges: RoadEdge[], startId: number, goalId: number, mode: TravelMode,
): PathDiagnosis {
  const byData = componentFrom(edges, startId, null);
  const byMode = componentFrom(edges, startId, mode);
  return {
    // Цель в общей компоненте, но не в компоненте режима — путь нарисован,
    // просто этим способом по нему не пройти.
    reason: byData.has(goalId) ? 'mode_blocked' : 'disconnected',
    reachable_any: byData.size,
    reachable_mode: byMode.size,
  };
}

/**
 * A* от startId к goalId. Рёбра двунаправленные (oneway на Камчатке
 * пренебрежимо мало вне города; учтём при необходимости).
 */
export function findPath(
  nodes: Map<number, RoadNode>,
  edges: RoadEdge[],
  startId: number,
  goalId: number,
  mode: TravelMode,
): RouteResult | null {
  const goal = nodes.get(goalId);
  const start = nodes.get(startId);
  if (!goal || !start) return null;
  if (startId === goalId) return { path: [startId], seconds: 0, meters: 0, geometry: [[start.lat, start.lng]] };

  const adj = adjacency(edges);

  // Эвристика: оптимистичное время по прямой (макс. скорость режима)
  const hSpeedMs = (mode === 'car' ? 90 : FOOT_SPEED_KMH) / 3.6;
  const h = (id: number) => {
    const n = nodes.get(id);
    return n ? haversineM(n.lat, n.lng, goal.lat, goal.lng) / hSpeedMs : 0;
  };

  const gScore = new Map<number, number>([[startId, 0]]);
  const cameFrom = new Map<number, { prev: number; edge: RoadEdge; reversed: boolean }>();
  const heap = new MinHeap();
  heap.push(startId, h(startId));
  const closed = new Set<number>();

  while (heap.size > 0) {
    const cur = heap.pop();
    if (!cur) break;
    if (closed.has(cur.id)) continue;
    closed.add(cur.id);
    if (cur.id === goalId) break;

    for (const { edge, to, reversed } of adj.get(cur.id) ?? []) {
      if (closed.has(to)) continue;
      const cost = edgeCostSeconds(edge, mode);
      if (!Number.isFinite(cost)) continue;
      const tentative = (gScore.get(cur.id) ?? Infinity) + cost;
      if (tentative < (gScore.get(to) ?? Infinity)) {
        gScore.set(to, tentative);
        cameFrom.set(to, { prev: cur.id, edge, reversed });
        heap.push(to, tentative + h(to));
      }
    }
  }

  if (!cameFrom.has(goalId)) return null;

  // Восстановление пути + склейка геометрии
  const path: number[] = [goalId];
  const geometry: Array<[number, number]> = [];
  let meters = 0;
  let cursor = goalId;
  const segments: Array<Array<[number, number]>> = [];
  while (cursor !== startId) {
    const step = cameFrom.get(cursor);
    if (!step) return null;
    meters += step.edge.length_m;
    const seg = step.reversed ? [...step.edge.geometry].reverse() : step.edge.geometry;
    segments.push(seg);
    cursor = step.prev;
    path.push(cursor);
  }
  path.reverse();
  segments.reverse();
  for (const seg of segments) {
    // без дублей стыковых точек: первую точку сегмента пропускаем, если уже есть
    const startIdx = geometry.length > 0 ? 1 : 0;
    for (let i = startIdx; i < seg.length; i++) geometry.push(seg[i]);
  }

  return {
    path,
    seconds: Math.round(gScore.get(goalId) ?? 0),
    meters: Math.round(meters),
    geometry,
  };
}
