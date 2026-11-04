// @vitest-environment node
/**
 * Отказ маршрутов не прячет места (04.11, лог прода:
 * `[search] места и маршруты недоступны: column "location_type" does not exist`).
 *
 * ILIKE-запрос маршрутов просил у kamchatka_routes колонку location_type,
 * которой там нет, а Promise.all ронял вместе с ним места и парки. Сторож
 * держит: SQL маршрутов не просит location_type; отказ маршрутов назван
 * 'routes', а места отдаются; причина отказа семантики наружу не уходит.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const queryMock = vi.fn();
const semanticMock = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => queryMock(...a) }));
vi.mock('@/lib/ai/embeddings', () => ({ semanticSearch: (...a: unknown[]) => semanticMock(...a) }));
vi.mock('@/lib/search/tour-query-match', () => ({
  findToursForQuery: vi.fn().mockResolvedValue([]),
  tourPriceFrom: () => null,
}));

import { GET } from '@/app/api/search/route';

const req = (q: string) => ({ url: `http://x/api/search?q=${encodeURIComponent(q)}` }) as unknown as NextRequest;
const PLACE = { id: 'p1', title: 'Авачинский вулкан', location_type: 'volcano' };
const ROUTE = { id: 'r1', title: 'Авачинский перевал', category: 'vulkani' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  semanticMock.mockRejectedValue(new Error('Error loading shared library ld-linux-x86-64.so.2: /app/node_modules/onnxruntime-node/bin/x.node'));
});

describe('/api/search: маршруты и места падают независимо', () => {
  it('SQL по kamchatka_routes не просит location_type', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await GET(req('авач'));
    const routeSql = queryMock.mock.calls.map(c => String(c[0])).filter(s => s.includes('kamchatka_routes'));
    expect(routeSql.length).toBeGreaterThan(0);
    for (const s of routeSql) expect(s).not.toMatch(/location_type/);
  });

  it('отказ маршрутов — места всё равно отдаются, unavailable: routes', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('kamchatka_routes')) return Promise.reject(new Error('column "location_type" does not exist'));
      if (sql.includes('FROM places')) return Promise.resolve({ rows: [PLACE] });
      return Promise.resolve({ rows: [] });
    });
    const res = await GET(req('авач'));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.some((r: { type: string }) => r.type === 'place')).toBe(true);
    expect(json.unavailable).toEqual(['routes']);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('отказ мест — маршруты отдаются, unavailable: places', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM places')) return Promise.reject(new Error('down'));
      if (sql.includes('kamchatka_routes')) return Promise.resolve({ rows: [ROUTE] });
      return Promise.resolve({ rows: [] });
    });
    const json = await (await GET(req('авач'))).json();
    const route = json.data.find((r: { type: string }) => r.type === 'route');
    expect(route.subtitle).toBe('Вулканы');
    expect(json.unavailable).toEqual(['places']);
  });

  it('отказ обеих частей — прежний geo', async () => {
    queryMock.mockImplementation((sql: string) =>
      sql.includes('FROM parks') ? Promise.resolve({ rows: [] }) : Promise.reject(new Error('down')));
    const json = await (await GET(req('авач'))).json();
    expect(json.unavailable).toEqual(['geo']);
  });

  it('отказ семантики: в ответе общая причина без путей и имён библиотек', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const json = await (await GET(req('авач'))).json();
    expect(json.degraded.semantic).toBe('unavailable');
    expect(json.degraded.reason).not.toMatch(/\/|\.so|onnx|node_modules/i);
  });
});
