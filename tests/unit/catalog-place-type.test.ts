/**
 * /api/routes?place_type= — вход и форма запроса (22.10, карта планировщика).
 *
 * Правило отбора (род связи, живое место, оба id маршрута) исполняется на
 * настоящем PostgreSQL — tests/integration/catalog-place-type.pg.test.ts.
 * Здесь то, что видно без базы и должно держаться в каждом прогоне CI:
 *   — вход проверяется Zod до SQL: чужой вид, заглавные, больше восьми — 400;
 *   — вид уходит одним параметром-массивом, а не текстом в SQL;
 *   — без параметра запрос прежний: ни условия, ни лишнего параметра.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/database', () => ({ query: vi.fn() }));

import { query } from '@/lib/database';
import { CatalogQuerySchema, queryCatalog } from '@/lib/routes/catalog-query';
import { GET } from '@/app/api/routes/route';

const queryMock = vi.mocked(query);

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 } as never);
});

describe('place_type: вход', () => {
  it('недопустимый вид — 400 до SQL', async () => {
    for (const bad of ['Volcano', 'volcano;drop', 'a,b,c,d,e,f,g,h,i', '', 'volcano,', "volcano'--"]) {
      const res = await GET(new NextRequest(`http://x/api/routes?place_type=${encodeURIComponent(bad)}`));
      expect(res.status, bad).toBe(400);
    }
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('несколько видов через запятую — список без повторов', () => {
    expect(CatalogQuerySchema.parse({ place_type: 'hot_spring,thermal,hot_spring' }).place_type)
      .toEqual(['hot_spring', 'thermal']);
    expect(CatalogQuerySchema.parse({}).place_type).toBeUndefined();
  });
});

describe('place_type: запрос', () => {
  it('вид уходит одним параметром-массивом, и в выборку, и в счёт', async () => {
    await queryCatalog(CatalogQuerySchema.parse({ place_type: 'bay,cape', hasCoords: 'true' }));
    expect(queryMock).toHaveBeenCalledTimes(2);
    for (const [sql, params] of queryMock.mock.calls as Array<[string, unknown[]]>) {
      expect(params).toContainEqual(['bay', 'cape']);
      expect(sql).not.toMatch(/'bay'|'cape'/);
      expect(sql).toMatch(/link_kind IN \('waypoint', 'unknown'\)/);
    }
  });

  it('без параметра — прежний запрос: ни условия по месту пути, ни лишнего параметра', async () => {
    await queryCatalog(CatalogQuerySchema.parse({ kind: 'route', hasCoords: 'true' }));
    const [[dataSql, dataParams], [countSql, countParams]] = queryMock.mock.calls as Array<[string, unknown[]]>;
    for (const sql of [dataSql, countSql]) expect(sql).not.toMatch(/location_type = ANY/);
    expect(countParams).toEqual(['route']);
    expect(dataParams).toEqual(['route', 24, 0]);
  });
});
