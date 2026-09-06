/**
 * Привязка к одной компоненте (05.09, перепись графа на проде).
 *
 * Николаевка → Паратунка и Паратунка → Термальный отвечали disconnected при
 * 17 тысячах узлов в окне: точка Паратунки садилась на ближайший узел, а он
 * стоял на изолированном обрывке. Сторож держит: при живой трассе чуть дальше
 * путь находится через неё (привязка честно длиннее), а когда связанной пары в
 * радиусе нет — остаётся честный disconnected по ближайшим узлам.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RoadNode, RoadEdge } from '@/lib/routing/astar';
import { componentIds, nearestNodesWithin, routableNodes } from '@/lib/routing/astar';
import { roadGraphRoute, pickConnectedPair, SNAP_CANDIDATES, SNAP_SLACK_M } from '@/lib/routing/road-graph-route';

const mockLoadSubgraph = vi.fn();
vi.mock('@/lib/routing/subgraph', () => ({
  loadSubgraph: (...args: unknown[]) => mockLoadSubgraph(...args),
}));

const node = (id: number, lat: number, lng: number): [number, RoadNode] => [id, { id, lat, lng }];
const edge = (from: number, to: number, length_m: number, highway = 'unclassified'): RoadEdge => ({
  from, to, length_m, highway, surface: null, geometry: [[0, 0], [0, 0]],
});

beforeEach(() => vi.clearAllMocks());

// Трасса A: 1 — 2 — 3 на север вдоль 158.000; обрывок B: 10 — 11 рядом с
// концом трассы, но ни с чем не соединён.
const nodes = new Map<number, RoadNode>([
  node(1, 53.000, 158.000), node(2, 53.010, 158.000), node(3, 53.020, 158.000),
  node(10, 53.0205, 158.0010), node(11, 53.0215, 158.0010),
]);
const edges: RoadEdge[] = [edge(1, 2, 1100), edge(2, 3, 1100), edge(10, 11, 110)];

describe('компоненты и кандидаты привязки', () => {
  it('componentIds: трасса и обрывок — разные компоненты, узлы без проходимых рёбер не входят', () => {
    const comp = componentIds(edges, 'car');
    expect(comp.get(1)).toBe(comp.get(3));
    expect(comp.get(10)).toBe(comp.get(11));
    expect(comp.get(1)).not.toBe(comp.get(10));
    const carOnly = componentIds([edge(1, 2, 100, 'path')], 'car');
    expect(carOnly.size).toBe(0);
  });

  it('nearestNodesWithin: по возрастанию, в радиусе, не больше limit', () => {
    const routable = routableNodes(edges, 'car');
    const c = nearestNodesWithin(nodes.values(), 53.0205, 158.0011, routable, 5000, 3);
    // Узел 3 (92 м) ближе узла 11 (111 м): порядок — по расстоянию, не по id.
    expect(c.map((x) => x.node.id)).toEqual([10, 3, 11]);
    expect(nearestNodesWithin(nodes.values(), 53.0205, 158.0011, routable, 5, 10)).toEqual([]);
  });

  it('pickConnectedPair: связанная пара с наименьшей суммой; несвязанные — null', () => {
    const comp = componentIds(edges, 'car');
    const starts = [{ node: nodes.get(1)!, distance_m: 0 }];
    const goals = [{ node: nodes.get(10)!, distance_m: 7 }, { node: nodes.get(3)!, distance_m: 70 }];
    expect(pickConnectedPair(starts, goals, comp)?.goal.node.id).toBe(3);
    expect(pickConnectedPair(starts, [{ node: nodes.get(10)!, distance_m: 7 }], comp)).toBeNull();
    // Связанный узел дальше «ближайший + SNAP_SLACK_M» — это другое место:
    // тупик тропы в километре от дороги не превращается в «ok».
    const farGoals = [{ node: nodes.get(10)!, distance_m: 7 }, { node: nodes.get(3)!, distance_m: 7 + SNAP_SLACK_M + 1 }];
    expect(pickConnectedPair(starts, farGoals, comp)).toBeNull();
    expect(SNAP_CANDIDATES).toBeGreaterThanOrEqual(10);
  });
});

describe('roadGraphRoute — точка у обрывка', () => {
  it('ближайший узел изолирован — путь строится через трассу, привязка честно длиннее', async () => {
    mockLoadSubgraph.mockResolvedValue({ nodes, edges });
    // Цель — в 7 м от узла 10 (обрывок) и в ~70 м от узла 3 (трасса).
    const r = await roadGraphRoute(53.000, 158.000, 53.0205, 158.0011, 'car');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.goal.lat).toBe(53.020);
    expect(r.goal.snapM).toBeGreaterThan(50);
    expect(r.distanceM).toBe(2200);
  });

  it('связанной пары в радиусе нет — честный disconnected по ближайшим узлам', async () => {
    // Только обрывок рядом с целью: трасса кончается за 5 км.
    const far = new Map<number, RoadNode>([
      node(1, 53.000, 158.000), node(2, 53.010, 158.000),
      node(10, 53.100, 158.000), node(11, 53.101, 158.000),
    ]);
    mockLoadSubgraph.mockResolvedValue({ nodes: far, edges: [edge(1, 2, 1100), edge(10, 11, 110)] });
    const r = await roadGraphRoute(53.000, 158.000, 53.100, 158.0001, 'car');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('disconnected');
    expect(r.goal?.snapM).toBeLessThan(20);
  });
});
