/**
 * lib/routing/subgraph.ts — запас bbox вокруг старта/финиша.
 *
 * Находка 29.08: Петропавловск→Мильково почти строго на север (lngSpan
 * ~0.03°), а трасса уходит ~100 км западнее по долине, прежде чем повернуть
 * обратно. Прежний запас (25% от СВОЕГО спана каждой оси) для такой пары
 * давал lngPad~0.12° — крюк трассы выпадал из bbox целиком, рёбра до него
 * не грузились (JOIN требует оба конца ребра внутри bbox), и честно связный
 * в БД граф отвечал disconnected. Тест фиксирует, что новый запас (от
 * БОЛЬШЕГО спана, не своего) покрывает этот реальный случай, и что короткий
 * внутригородской запрос не остаётся с нулевым запасом.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/database', () => ({ query: vi.fn() }));

import { query } from '@/lib/database';
import { loadSubgraph } from '@/lib/routing/subgraph';

const queryMock = vi.mocked(query);

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 } as never);
});

describe('loadSubgraph — запас bbox', () => {
  it('Петропавловск→Мильково: bbox по долготе доходит хотя бы до 157.9 (реальный крюк трассы)', async () => {
    await loadSubgraph(53.0195, 158.6494, 54.695, 158.62);

    const [nodesSql, nodesParams] = queryMock.mock.calls[0] as [string, number[]];
    expect(nodesSql).toContain('road_graph_nodes');
    const [minLat, maxLat, minLng, maxLng] = nodesParams;

    // Найденный на практике разрыв: точка 157.838/157.916 должна попасть в bbox.
    expect(minLng).toBeLessThanOrEqual(157.8);
    expect(maxLng).toBeGreaterThanOrEqual(158.7);
    expect(minLat).toBeLessThanOrEqual(53.0195);
    expect(maxLat).toBeGreaterThanOrEqual(54.695);
  });

  it('короткий внутригородской запрос: запас не схлопывается в почти нулевой', async () => {
    // Два адреса в Петропавловске в паре км друг от друга — оба спана крошечные.
    await loadSubgraph(53.02, 158.65, 53.03, 158.66);

    const [, nodesParams] = queryMock.mock.calls[0] as [string, number[]];
    const [minLat, maxLat, minLng, maxLng] = nodesParams;

    // Пол запаса — не меньше ~30 км в каждую сторону, как и раньше был пол 0.07/0.12.
    expect(maxLat - minLat).toBeGreaterThanOrEqual(0.6);
    expect(maxLng - minLng).toBeGreaterThanOrEqual(0.6);
  });

  it('пустой результат nodes → пустой подграф без запроса edges', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const result = await loadSubgraph(53, 158, 53.1, 158.1);
    expect(result.nodes.size).toBe(0);
    expect(result.edges).toEqual([]);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
