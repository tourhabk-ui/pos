/**
 * lib/routing/road-graph-route.ts — общее ядро своего роутера (владелец
 * 28.08, вынесено из /api/routing/path без изменения поведения). Проверяет
 * оба слоя решений: отсечка снапа (MAX_SNAP_M=5000, до A*) и причины отказа
 * A* (empty_graph/too_far_from_road/disconnected/mode_blocked), плюс что
 * координаты снапнутых узлов доходят до вызывающего (нужны
 * roadGraphCarProvider для originSnapped/destinationSnapped).
 *
 * loadSubgraph мокается напрямую (не @/lib/database) — тест ядра решений,
 * не SQL: подграф собирается в памяти, как в tests/unit/routing-astar.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RoadNode, RoadEdge } from '@/lib/routing/astar';
import { roadGraphRoute, MAX_SNAP_M } from '@/lib/routing/road-graph-route';

const mockLoadSubgraph = vi.fn();
vi.mock('@/lib/routing/subgraph', () => ({
  loadSubgraph: (...args: unknown[]) => mockLoadSubgraph(...args),
}));

const node = (id: number, lat: number, lng: number): [number, RoadNode] => [id, { id, lat, lng }];
const edge = (from: number, to: number, length_m: number, highway = 'unclassified'): RoadEdge => ({
  from, to, length_m, highway, surface: null,
  geometry: [[0, 0], [0, 0]],
});

beforeEach(() => vi.clearAllMocks());

describe('roadGraphRoute — успех', () => {
  it('найденный путь: расстояние, время, координаты снапнутых узлов', async () => {
    // Ромб car-проходимый, тот же, что в routing-astar.test.ts
    const nodes = new Map<number, RoadNode>([
      node(1, 53.00, 158.00), node(2, 53.01, 158.00),
      node(3, 53.00, 158.02), node(4, 53.01, 158.02),
    ]);
    const edges: RoadEdge[] = [
      edge(1, 2, 1000), edge(2, 4, 1000), edge(1, 3, 3000), edge(3, 4, 3000),
    ];
    mockLoadSubgraph.mockResolvedValue({ nodes, edges });

    const result = await roadGraphRoute(53.00, 158.00, 53.01, 158.02, 'car');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.distanceM).toBe(2000);
    expect(result.durationS).toBeGreaterThan(0);
    // Запрос точно в узлах — снап 0, координаты узла возвращаются как есть.
    expect(result.start).toEqual({ lat: 53.00, lng: 158.00, snapM: 0 });
    expect(result.goal).toEqual({ lat: 53.01, lng: 158.02, snapM: 0 });
    expect(result.mode).toBe('car');
  });
});

describe('roadGraphRoute — empty_graph', () => {
  it('пустой подграф (нет узлов в bbox)', async () => {
    mockLoadSubgraph.mockResolvedValue({ nodes: new Map(), edges: [] });
    const result = await roadGraphRoute(53, 158, 53.1, 158.1, 'car');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty_graph');
    expect(result.message).toBe('Дорог в этом районе у нас в данных нет');
    expect(result.start).toBeUndefined();
  });

  it('узлы есть, но ни одно ребро не проезжаемо машиной — car-специфичное сообщение', async () => {
    const nodes = new Map<number, RoadNode>([node(1, 53, 158), node(2, 53.01, 158.01)]);
    const edges: RoadEdge[] = [edge(1, 2, 500, 'path')]; // тропа — не машиной
    mockLoadSubgraph.mockResolvedValue({ nodes, edges });

    const result = await roadGraphRoute(53, 158, 53.01, 158.01, 'car');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty_graph');
    expect(result.message).toBe('Проезжих дорог в этом районе у нас в данных нет');
    expect(result.graph?.routable).toBe(0);
  });

  it('пешком — общее сообщение, не car-специфичное', async () => {
    mockLoadSubgraph.mockResolvedValue({ nodes: new Map(), edges: [] });
    const result = await roadGraphRoute(53, 158, 53.1, 158.1, 'foot');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe('Дорог в этом районе у нас в данных нет');
  });
});

describe('roadGraphRoute — too_far_from_road', () => {
  it('снап дальше MAX_SNAP_M — путь не строится, снап-дистанции честные', async () => {
    const nodes = new Map<number, RoadNode>([node(1, 53.00, 158.00), node(2, 53.01, 158.00)]);
    const edges: RoadEdge[] = [edge(1, 2, 1000)];
    mockLoadSubgraph.mockResolvedValue({ nodes, edges });

    // Точка запроса далеко от ОБОИХ узлов (> MAX_SNAP_M от ближайшего — узла 2)
    const farLat = 53.01 + (MAX_SNAP_M + 500) / 111_000;
    const result = await roadGraphRoute(farLat, 158.00, 53.01, 158.00, 'car');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too_far_from_road');
    expect(result.start!.snapM).toBeGreaterThan(MAX_SNAP_M);
    expect(result.message).toBe('До ближайшей дороги слишком далеко — подъезд не строим');
  });
});

describe('roadGraphRoute — mode_blocked vs disconnected', () => {
  it('mode_blocked: дорога до цели есть (без учёта режима), но машиной не проехать', async () => {
    // 1--2 (проезжая), 2--3 (тропа, только пешком), 3--4 (проезжая)
    const nodes = new Map<number, RoadNode>([
      node(1, 53.00, 158.00), node(2, 53.00, 158.01),
      node(3, 53.00, 158.02), node(4, 53.00, 158.03),
    ]);
    const edges: RoadEdge[] = [
      edge(1, 2, 500, 'unclassified'),
      edge(2, 3, 500, 'path'),
      edge(3, 4, 500, 'unclassified'),
    ];
    mockLoadSubgraph.mockResolvedValue({ nodes, edges });

    const result = await roadGraphRoute(53.00, 158.00, 53.00, 158.03, 'car');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('mode_blocked');
    expect(result.message).toBe('Дорога есть, но проехать по ней нельзя — только пешком');
  });

  it('disconnected: цель в графе, но не связана с началом никак', async () => {
    // {1,2} и {3,4} — два несвязных куска, оба проезжие
    const nodes = new Map<number, RoadNode>([
      node(1, 53.00, 158.00), node(2, 53.00, 158.01),
      node(3, 53.50, 158.50), node(4, 53.50, 158.51),
    ]);
    const edges: RoadEdge[] = [
      edge(1, 2, 500, 'unclassified'),
      edge(3, 4, 500, 'unclassified'),
    ];
    mockLoadSubgraph.mockResolvedValue({ nodes, edges });

    const result = await roadGraphRoute(53.00, 158.00, 53.50, 158.51, 'car');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('disconnected');
    expect(result.message).toBe('Связного пути по нашим данным нет');
  });
});
