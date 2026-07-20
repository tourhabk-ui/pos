/**
 * Билдер дорожного графа из OSM-ways: узлы на перекрёстках и концах,
 * рёбра-сегменты с длиной по гаверсинусу и полилинией, фильтр highway.
 */

import { describe, it, expect } from 'vitest';
// CJS-модуль без зависимостей — общий для раннера и тестов
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildGraph, haversineM, chunk } = require('../../scripts/road-graph-builder.js');

type OsmWay = {
  type: 'way';
  id: number;
  tags?: Record<string, string>;
  nodes?: number[];
  geometry?: Array<{ lat: number; lon: number }>;
};

const way = (id: number, nodes: number[], coords: Array<[number, number]>, tags: Record<string, string> = { highway: 'track' }): OsmWay => ({
  type: 'way',
  id,
  tags,
  nodes,
  geometry: coords.map(([lat, lon]) => ({ lat, lon })),
});

describe('buildGraph', () => {
  it('прямая дорога без перекрёстков → одно ребро от конца до конца, промежуточные точки в полилинии', () => {
    const g = buildGraph([
      way(1, [10, 11, 12], [[53.0, 158.0], [53.001, 158.0], [53.002, 158.0]]),
    ]);
    expect(g.nodes.size).toBe(2);
    expect(g.edges.length).toBe(1);
    const e = g.edges[0];
    expect(e.from).toBe(10);
    expect(e.to).toBe(12);
    expect(e.geometry.length).toBe(3);
    // ~222 м на 0.002° широты
    expect(e.length_m).toBeGreaterThan(200);
    expect(e.length_m).toBeLessThan(250);
  });

  it('перекрёсток режет дорогу на два ребра', () => {
    const g = buildGraph([
      way(1, [10, 11, 12], [[53.0, 158.0], [53.001, 158.0], [53.002, 158.0]]),
      // вторая дорога проходит через узел 11 → он перекрёсток
      way(2, [11, 20], [[53.001, 158.0], [53.001, 158.002]]),
    ]);
    const edgesFromWay1 = g.edges.filter((e: { from: number }) => [10, 11].includes(e.from));
    expect(g.nodes.has(11)).toBe(true);
    expect(edgesFromWay1.length).toBeGreaterThanOrEqual(2);
    expect(g.edges.length).toBe(3); // 10-11, 11-12, 11-20
  });

  it('не-дорожные и битые ways отфильтрованы', () => {
    const g = buildGraph([
      way(1, [1, 2], [[53, 158], [53.001, 158]], { highway: 'construction' }),
      way(2, [3, 4], [[53, 158], [53.001, 158]], { building: 'yes' } as Record<string, string>),
      { type: 'way', id: 3, tags: { highway: 'track' }, nodes: [5], geometry: [{ lat: 53, lon: 158 }] },
    ]);
    expect(g.edges.length).toBe(0);
  });

  it('haversineM: ПК → Елизово ≈ 29 км', () => {
    const d = haversineM(53.0195, 158.6505, 53.1830, 158.3883);
    expect(d).toBeGreaterThan(25_000);
    expect(d).toBeLessThan(32_000);
  });

  it('chunk режет ровно', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
