/**
 * lib/routing/subgraph.ts
 *
 * Загрузка подграфа дорог из БД (миграция 760) для A*: bbox вокруг
 * старта и финиша с запасом — реальный путь по дорогам может выходить
 * за прямоугольник между точками (объезд залива, единственный мост).
 */

import { query } from '@/lib/database';
import type { RoadNode, RoadEdge } from '@/lib/routing/astar';

// Жёсткий предохранитель: подграф больше — что-то не так с bbox
const MAX_EDGES = 120_000;

export interface Subgraph {
  nodes: Map<number, RoadNode>;
  edges: RoadEdge[];
}

interface EdgeRow {
  from_node: string;
  to_node: string;
  length_m: number;
  highway: string;
  surface: string | null;
  geometry: Array<[number, number]> | null;
}

/**
 * bbox вокруг двух точек с запасом: 25% диагонали, минимум ~7 км.
 * На пустом графе вернёт пустой подграф — решает вызывающий.
 */
export async function loadSubgraph(
  fromLat: number, fromLng: number,
  toLat: number, toLng: number,
): Promise<Subgraph> {
  const latSpan = Math.abs(fromLat - toLat);
  const lngSpan = Math.abs(fromLng - toLng);
  const latPad = Math.max(latSpan * 0.25, 0.07);
  const lngPad = Math.max(lngSpan * 0.25, 0.12);

  const minLat = Math.min(fromLat, toLat) - latPad;
  const maxLat = Math.max(fromLat, toLat) + latPad;
  const minLng = Math.min(fromLng, toLng) - lngPad;
  const maxLng = Math.max(fromLng, toLng) + lngPad;

  const nodesRes = await query<{ id: string; lat: number; lng: number }>(
    `SELECT id::text, lat, lng FROM road_graph_nodes
     WHERE lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4`,
    [minLat, maxLat, minLng, maxLng],
  );

  const nodes = new Map<number, RoadNode>();
  for (const r of nodesRes.rows) {
    const id = Number(r.id);
    nodes.set(id, { id, lat: r.lat, lng: r.lng });
  }
  if (nodes.size === 0) return { nodes, edges: [] };

  // Рёбра, оба конца которых в bbox (граничные рёбра теряем — запас bbox
  // это компенсирует)
  const edgesRes = await query<EdgeRow>(
    `SELECT e.from_node::text, e.to_node::text, e.length_m, e.highway, e.surface, e.geometry
     FROM road_graph_edges e
     JOIN road_graph_nodes a ON a.id = e.from_node
     JOIN road_graph_nodes b ON b.id = e.to_node
     WHERE a.lat BETWEEN $1 AND $2 AND a.lng BETWEEN $3 AND $4
       AND b.lat BETWEEN $1 AND $2 AND b.lng BETWEEN $3 AND $4
     LIMIT ${MAX_EDGES + 1}`,
    [minLat, maxLat, minLng, maxLng],
  );

  if (edgesRes.rows.length > MAX_EDGES) {
    throw new Error(`Подграф слишком велик (> ${MAX_EDGES} рёбер) — сузьте запрос`);
  }

  const edges: RoadEdge[] = edgesRes.rows.map((r) => ({
    from: Number(r.from_node),
    to: Number(r.to_node),
    length_m: r.length_m,
    highway: r.highway,
    surface: r.surface,
    geometry: Array.isArray(r.geometry) ? r.geometry : [],
  }));

  return { nodes, edges };
}
