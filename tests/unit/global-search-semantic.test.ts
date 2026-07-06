/**
 * tests/unit/global-search-semantic.test.ts
 *
 * GET /api/search (GlobalSearchModal, Ctrl+K) — секция маршрутов теперь ищет
 * семантикой (lib/ai/embeddings.semanticSearch) с честным ILIKE-фоллбэком.
 * Контракт: id/type/title/subtitle/href — байт-в-байт прежний; семантические
 * хиты типизируются через agent_route_knowledge (места не попадают в секцию
 * маршрутов); семантика упала или пуста → прежний ILIKE; места — всегда ILIKE.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

const semanticSearchMock = vi.fn();
vi.mock('@/lib/ai/embeddings', () => ({
  semanticSearch: (...args: unknown[]) => semanticSearchMock(...args),
}));

import { GET } from '@/app/api/search/route';

const ROUTE_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PLACE_UUID = '11111111-2222-3333-4444-555555555555';

function req(q: string): NextRequest {
  return new Request(
    `http://localhost/api/search?q=${encodeURIComponent(q)}&limit=8`
  ) as unknown as NextRequest;
}

function mockSql(handlers: Record<string, unknown[]>) {
  queryMock.mockImplementation((sql: string) => {
    for (const [needle, rows] of Object.entries(handlers)) {
      if (sql.includes(needle)) return Promise.resolve({ rows });
    }
    throw new Error('unexpected SQL: ' + sql);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/search — семантика для маршрутов', () => {
  it('семантические хиты → секция маршрутов из них, места отфильтрованы по kind', async () => {
    semanticSearchMock.mockResolvedValue([
      { id: PLACE_UUID, title: 'Курильское озеро', similarity: 0.9 },
      { id: ROUTE_UUID, title: 'К медведям Курильского озера', similarity: 0.8 },
    ]);
    mockSql({
      'FROM agent_route_knowledge': [
        { id: PLACE_UUID, title: 'Курильское озеро', category: null, location_type: 'lake', kind: 'place' },
        { id: ROUTE_UUID, title: 'К медведям Курильского озера', category: 'medvedi', location_type: null, kind: 'route' },
      ],
      'FROM places': [],
      'FROM parks': [],
    });

    const res = await GET(req('где увидеть медведей'));
    const json = await res.json();

    expect(res.status).toBe(200);
    const routes = json.data.filter((r: { type: string }) => r.type === 'route');
    expect(routes).toEqual([{
      id: `route-${ROUTE_UUID}`,
      type: 'route',
      title: 'К медведям Курильского озера',
      subtitle: 'Медведи',
      href: `/routes/${ROUTE_UUID}`,
    }]);
    // ILIKE-запрос по kamchatka_routes не выполнялся
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('FROM kamchatka_routes'))).toBe(false);
  });

  it('семантика бросает → прежний ILIKE-фоллбэк, контракт не меняется', async () => {
    semanticSearchMock.mockRejectedValue(new Error('column embedding does not exist'));
    mockSql({
      'FROM kamchatka_routes': [
        { id: ROUTE_UUID, title: 'Авачинский перевал', category: 'trekking', location_type: null, slug: 'avacha' },
      ],
      'FROM places': [],
      'FROM parks': [],
    });

    const res = await GET(req('авачинский'));
    const json = await res.json();

    expect(res.status).toBe(200);
    const routes = json.data.filter((r: { type: string }) => r.type === 'route');
    expect(routes).toEqual([{
      id: `route-${ROUTE_UUID}`,
      type: 'route',
      title: 'Авачинский перевал',
      subtitle: 'Треккинг',
      href: `/routes/${ROUTE_UUID}`,
    }]);
  });

  it('семантика пуста → ILIKE-фоллбэк', async () => {
    semanticSearchMock.mockResolvedValue([]);
    mockSql({
      'FROM kamchatka_routes': [],
      'FROM places': [
        { id: PLACE_UUID, title: 'Голубые озёра', location_type: 'lake', subtitle: 'Озёра' },
      ],
      'FROM parks': [],
    });

    const res = await GET(req('озеро'));
    const json = await res.json();

    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('FROM kamchatka_routes'))).toBe(true);
    const places = json.data.filter((r: { type: string }) => r.type === 'place');
    expect(places[0]).toEqual({
      id: `place-${PLACE_UUID}`,
      type: 'place',
      title: 'Голубые озёра',
      subtitle: 'Озеро',
      href: `/places/${PLACE_UUID}`,
    });
  });

  it('короткий запрос (<3 символов) → семантика не вызывается', async () => {
    mockSql({ 'FROM kamchatka_routes': [], 'FROM places': [], 'FROM parks': [] });

    await GET(req('ав'));
    expect(semanticSearchMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/search — парки в результатах', () => {
  it('парк из справочника → элемент type=park со ссылкой на /park/[slug]', async () => {
    semanticSearchMock.mockResolvedValue([]);
    mockSql({
      'FROM kamchatka_routes': [],
      'FROM places': [],
      'FROM parks': [{ slug: 'nalychevo', display_name: 'Природный парк «Налычево»' }],
    });

    const res = await GET(req('Налычево'));
    const json = await res.json();

    const parks = json.data.filter((r: { type: string }) => r.type === 'park');
    expect(parks).toEqual([{
      id: 'park-nalychevo',
      type: 'park',
      title: 'Природный парк «Налычево»',
      subtitle: 'Природный парк',
      href: '/park/nalychevo',
    }]);
  });

  it('ошибка запроса парков не роняет поиск (fail-soft)', async () => {
    semanticSearchMock.mockResolvedValue([]);
    queryMock.mockImplementation((sql: string) =>
      String(sql).includes('FROM parks')
        ? Promise.reject(new Error('relation parks does not exist'))
        : Promise.resolve({ rows: [] })
    );

    const res = await GET(req('Налычево'));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.filter((r: { type: string }) => r.type === 'park')).toEqual([]);
  });
});
