/**
 * Поиск маршрутов /api/routes/search: регрессия 500-ки (difficulty_level —
 * несуществующая колонка) и фоллбэк по названию МЕСТА (навигаторный выбор).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/database', () => ({ query: vi.fn() }));
vi.mock('@/lib/ai/embeddings', () => ({ semanticSearch: vi.fn() }));
vi.mock('@/lib/ai/route-knowledge', () => ({
  getRouteSearchCache: vi.fn(() => null),
  setRouteSearchCache: vi.fn(),
}));

import { NextRequest } from 'next/server';
import { query } from '@/lib/database';
import { semanticSearch } from '@/lib/ai/embeddings';
import { GET } from '@/app/api/routes/search/route';

const queryMock = vi.mocked(query);
const semanticMock = vi.mocked(semanticSearch);

const req = (q: string) => new NextRequest(`http://x/api/routes/search?q=${encodeURIComponent(q)}`);

beforeEach(() => {
  queryMock.mockReset();
  semanticMock.mockReset();
  semanticMock.mockResolvedValue([]); // семантика пуста → фоллбэк
});

describe('/api/routes/search — фоллбэк', () => {
  it('SQL берёт difficulty AS difficulty_level и фильтрует видимость (регрессия 500)', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 } as never);
    const res = await GET(req('Авачинский'));
    expect(res.status).toBe(200);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain('difficulty AS difficulty_level');
    expect(sql).not.toMatch(/r\.difficulty_level/);
    expect(sql).toContain('r.is_visible = TRUE');
  });

  it('ищет и по названию места на маршруте (route_waypoints EXISTS)', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 } as never);
    await GET(req('Авачинский'));
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain('EXISTS');
    expect(sql).toContain('p2.name ILIKE $1');
  });

  it('ошибка БД → 200 с пустым списком, не 500 (полевой UI)', async () => {
    queryMock.mockRejectedValue(new Error('column does not exist'));
    const res = await GET(req('Авачинский'));
    expect(res.status).toBe(200);
    const body = await res.json() as { routes: unknown[] };
    expect(body.routes).toEqual([]);
  });
});
