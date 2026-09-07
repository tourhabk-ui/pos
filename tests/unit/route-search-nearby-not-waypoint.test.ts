/**
 * /api/routes/search не путает «рядом» с «по пути» (§4.1 CLAUDE.md,
 * lib/routes/link-kind.ts).
 *
 * Владелец 07.09: карточка места «Дикие озерки» открывала трек «Зеленовские
 * озерки». Причина — `route_waypoints` джойнился без учёта `link_kind`:
 * место, привязанное к чужому маршруту как `nearby` («это рядом, загляните»,
 * не точка пути), засчитывалось наравне с настоящими путевыми точками этого
 * маршрута. Поиск по имени места находил маршрут, который мимо него не
 * проходит, и navigator-выбор (_PlanningClient, groupRoutesByPlace) открывал
 * ЕГО трек, выдавая его за путь к месту.
 *
 * Три места джойна route_waypoints в этом файле обязаны отсекать `nearby`
 * одним и тем же способом: `COALESCE(link_kind, 'unknown') <> 'nearby'` —
 * `unknown` считается путём НАМЕРЕННО (не размеченное не значит «рядом»).
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
});

const NEARBY_EXCLUSION = "COALESCE(rw.link_kind, 'unknown') <> 'nearby'";

describe('/api/routes/search — nearby не считается путевой точкой', () => {
  it('ILIKE-фоллбэк: все четыре ARRAY_AGG(waypoint_*) отсекают nearby', async () => {
    semanticMock.mockResolvedValue([]);
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 } as never);
    await GET(req('Дикие озерки'));
    const sql = String(queryMock.mock.calls[0][0]);
    const count = sql.split(NEARBY_EXCLUSION).length - 1;
    expect(count).toBeGreaterThanOrEqual(4);
  });

  it('ILIKE-фоллбэк: EXISTS по имени места (rw2) тоже отсекает nearby', async () => {
    semanticMock.mockResolvedValue([]);
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 } as never);
    await GET(req('Дикие озерки'));
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toMatch(/rw2\.route_id = r\.id AND p2\.is_visible = TRUE AND p2\.name ILIKE \$1\s*\n\s*AND COALESCE\(rw2\.link_kind, 'unknown'\) <> 'nearby'/);
  });

  it('ILIKE-фоллбэк: замер компактности bbox (rw3) тоже отсекает nearby', async () => {
    semanticMock.mockResolvedValue([]);
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 } as never);
    await GET(req('Дикие озерки'));
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toMatch(/rw3\.route_id = r\.id AND p3\.lat IS NOT NULL AND p3\.lng IS NOT NULL\s*\n\s*AND COALESCE\(rw3\.link_kind, 'unknown'\) <> 'nearby'/);
  });

  it('семантическая ветка (ENRICH_SQL) тоже отсекает nearby — тот же баг, другой путь кода', async () => {
    semanticMock.mockResolvedValue([{ id: 'r1', similarity: 0.9 }]);
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 } as never);
    await GET(req('Дикие озерки'));
    const sql = String(queryMock.mock.calls[0][0]);
    const count = sql.split(NEARBY_EXCLUSION).length - 1;
    expect(count).toBeGreaterThanOrEqual(4);
  });

  it('unknown (не размечено) по-прежнему считается путевой точкой — не исключается', async () => {
    semanticMock.mockResolvedValue([]);
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 } as never);
    await GET(req('Дикие озерки'));
    const sql = String(queryMock.mock.calls[0][0]);
    // Формула — COALESCE(..., 'unknown') <> 'nearby': unknown проходит фильтр,
    // а не исключается вместе с nearby.
    expect(sql).not.toMatch(/<>\s*'unknown'/);
  });
});
