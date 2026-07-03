import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

const mockExpandQuery = vi.fn();
vi.mock('@/lib/ai/query-expansion', () => ({
  expandQuery: (...args: unknown[]) => mockExpandQuery(...args),
}));

import { searchRoutes } from '@/lib/ai/route-knowledge';

describe('searchRoutes — query expansion logging (issue #250)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not log when expansion is off (variants === [base])', async () => {
    mockExpandQuery.mockResolvedValue(['вулкан']);
    mockQuery.mockResolvedValue({ rows: [{ title: 'Авачинский', description: 'd', activity_type: null }] });

    await searchRoutes('вулкан');

    // Единственный вызов pool.query — сам поиск маршрутов, лога нет
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('logs expanded_count and unique_added=0 when expansion adds no new routes', async () => {
    mockExpandQuery.mockResolvedValue(['вулкан', 'сопка']);
    mockQuery.mockResolvedValue({ rows: [{ title: 'Авачинский', description: 'd', activity_type: null }] });

    await searchRoutes('вулкан');

    const logCall = mockQuery.mock.calls.find(c => (c[0] as string).includes('query_expansion_log'));
    expect(logCall).toBeDefined();
    const [, params] = logCall!;
    expect(params).toEqual(['вулкан', 1, 0]); // 1 вариант сверх оригинала, 0 новых маршрутов (тот же title)
  });

  it('logs unique_added>0 when a variant surfaces a route the base query did not', async () => {
    mockExpandQuery.mockResolvedValue(['вулкан', 'сопка']);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ title: 'Авачинский', description: 'd', activity_type: null }] }) // base
      .mockResolvedValueOnce({ rows: [{ title: 'Корякский', description: 'd', activity_type: null }] })  // variant
      .mockResolvedValueOnce({ rows: [] }); // log insert

    await searchRoutes('вулкан');

    const logCall = mockQuery.mock.calls.find(c => (c[0] as string).includes('query_expansion_log'));
    const [, params] = logCall!;
    expect(params).toEqual(['вулкан', 1, 1]);
  });

  it('does not throw when the log insert fails', async () => {
    mockExpandQuery.mockResolvedValue(['вулкан', 'сопка']);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ title: 'Авачинский', description: 'd', activity_type: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('db down'));

    await expect(searchRoutes('вулкан')).resolves.not.toThrow();
  });
});
