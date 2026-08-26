/**
 * GET /api/trending — регрессия id-пространства.
 *
 * _TrendingClient.tsx строит href на /routes/[id] из поля id, вернувшегося
 * этим запросом. /routes/[id] ищет по VIEW agent_route_knowledge, где
 * id = COALESCE(ark_id, id). Голый kamchatka_routes.id у записи с
 * заполненным ark_id там не находится — «популярное» на /trending вело
 * на 404. Тот же разбор и та же формула уже стоят в
 * /api/routes/search/route.ts; здесь исправление не было применено.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQueryMock(...a) } }));

import { GET } from '@/app/api/trending/route';

beforeEach(() => {
  poolQueryMock.mockReset();
  poolQueryMock.mockResolvedValue({ rows: [] });
});

describe('GET /api/trending — id маршрута в пространстве VIEW', () => {
  it('SQL отдаёт COALESCE(ark_id, id) AS id, а не голый id', async () => {
    await GET(new Request('http://x/api/trending?type=routes'));

    const routesSql = String(
      poolQueryMock.mock.calls.map(([sql]) => sql).find((sql: string) => sql.includes('FROM kamchatka_routes'))
    );
    expect(routesSql).toContain('COALESCE(ark_id, id) AS id');
    expect(routesSql).not.toMatch(/SELECT id,/);
  });

  it('фильтрует слитые записи (merged_into_id)', async () => {
    await GET(new Request('http://x/api/trending?type=routes'));

    const routesSql = String(
      poolQueryMock.mock.calls.map(([sql]) => sql).find((sql: string) => sql.includes('FROM kamchatka_routes'))
    );
    expect(routesSql).toContain('merged_into_id IS NULL');
  });
});
