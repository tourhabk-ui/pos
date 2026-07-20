/**
 * A*-роутер (Этап 2): кратчайший путь по времени, модель скоростей
 * car/foot (тропы непроезжаемы машиной), склейка полилинии с реверсом
 * рёбер, ближайший узел.
 */

import { describe, it, expect } from 'vitest';
import {
  findPath,
  edgeCostSeconds,
  nearestNode,
  type RoadNode,
  type RoadEdge,
} from '@/lib/routing/astar';

const node = (id: number, lat: number, lng: number): [number, RoadNode] => [id, { id, lat, lng }];
const edge = (from: number, to: number, length_m: number, highway = 'unclassified', geometry?: Array<[number, number]>): RoadEdge => ({
  from, to, length_m, highway, surface: null,
  geometry: geometry ?? [[0, 0], [0, 0]],
});

describe('edgeCostSeconds', () => {
  it('машина: тропы непроходимы, грунтовка медленнее асфальта', () => {
    expect(edgeCostSeconds({ length_m: 1000, highway: 'path', surface: null }, 'car')).toBe(Infinity);
    const asphalt = edgeCostSeconds({ length_m: 1000, highway: 'primary', surface: null }, 'car');
    const dirt = edgeCostSeconds({ length_m: 1000, highway: 'primary', surface: 'dirt' }, 'car');
    expect(dirt).toBeGreaterThan(asphalt);
  });

  it('пешком проходимо всё, ~13 минут на километр', () => {
    const s = edgeCostSeconds({ length_m: 1000, highway: 'path', surface: null }, 'foot');
    expect(s).toBeGreaterThan(700);
    expect(s).toBeLessThan(900);
  });
});

describe('findPath', () => {
  // Ромб: 1 → 2 → 4 (короткая) против 1 → 3 → 4 (длинная)
  const nodes = new Map<number, RoadNode>([
    node(1, 53.00, 158.00),
    node(2, 53.01, 158.00),
    node(3, 53.00, 158.02),
    node(4, 53.01, 158.02),
  ]);
  const edges: RoadEdge[] = [
    edge(1, 2, 1000, 'unclassified', [[53.00, 158.00], [53.01, 158.00]]),
    edge(2, 4, 1000, 'unclassified', [[53.01, 158.00], [53.01, 158.02]]),
    edge(1, 3, 3000, 'unclassified', [[53.00, 158.00], [53.00, 158.02]]),
    edge(3, 4, 3000, 'unclassified', [[53.00, 158.02], [53.01, 158.02]]),
  ];

  it('выбирает короткую ветку ромба', () => {
    const r = findPath(nodes, edges, 1, 4, 'car');
    expect(r).not.toBeNull();
    expect(r!.path).toEqual([1, 2, 4]);
    expect(r!.meters).toBe(2000);
    expect(r!.seconds).toBeGreaterThan(0);
  });

  it('рёбра двунаправленные: путь 4 → 1 существует, геометрия реверсится без дублей стыков', () => {
    const r = findPath(nodes, edges, 4, 1, 'car');
    expect(r).not.toBeNull();
    expect(r!.path).toEqual([4, 2, 1]);
    expect(r!.geometry[0]).toEqual([53.01, 158.02]);
    expect(r!.geometry[r!.geometry.length - 1]).toEqual([53.00, 158.00]);
    expect(r!.geometry.length).toBe(3); // 3 точки, стык не задвоен
  });

  it('машина не едет по тропе: если единственный путь — path, пути нет; пешком — есть', () => {
    const trailEdges = [edge(1, 2, 500, 'path', [[53.00, 158.00], [53.01, 158.00]])];
    expect(findPath(nodes, trailEdges, 1, 2, 'car')).toBeNull();
    expect(findPath(nodes, trailEdges, 1, 2, 'foot')).not.toBeNull();
  });

  it('несвязный граф → null; старт = финиш → нулевой путь', () => {
    const disconnected = [edge(1, 2, 1000), edge(3, 4, 1000)];
    expect(findPath(nodes, disconnected, 1, 4, 'car')).toBeNull();
    const same = findPath(nodes, edges, 2, 2, 'car');
    expect(same!.meters).toBe(0);
  });
});

describe('nearestNode', () => {
  it('находит ближайший узел и честную дистанцию до него', () => {
    const nodes = [
      { id: 1, lat: 53.00, lng: 158.00 },
      { id: 2, lat: 53.10, lng: 158.10 },
    ];
    const r = nearestNode(nodes, 53.01, 158.0);
    expect(r!.node.id).toBe(1);
    expect(r!.distance_m).toBeGreaterThan(1000);
    expect(r!.distance_m).toBeLessThan(1300);
  });
});
