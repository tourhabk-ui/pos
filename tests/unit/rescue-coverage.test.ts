import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeRescueCoverage } from '@/lib/services/rescue-coverage';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

describe('computeRescueCoverage (issue #247 — MChS contact coverage)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports coveragePercent=100 and routesMissing=[] when every route has a phone', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { id: 'a', mchs_phone: '+7-415-2-11-05-05' },
        { id: 'b', mchs_phone: '+7-415-2-11-05-06' },
      ],
    });

    const r = await computeRescueCoverage();

    expect(r.totalRoutes).toBe(2);
    expect(r.withRescueContacts).toBe(2);
    expect(r.coveragePercent).toBe(100);
    expect(r.routesMissing).toEqual([]);
  });

  it('lists route IDs missing a phone (null or empty/whitespace)', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        { id: 'a', mchs_phone: '+7-415-2-11-05-05' },
        { id: 'b', mchs_phone: null },
        { id: 'c', mchs_phone: '   ' },
      ],
    });

    const r = await computeRescueCoverage();

    expect(r.withRescueContacts).toBe(1);
    expect(r.routesMissing).toEqual(['b', 'c']);
    expect(r.coveragePercent).toBeCloseTo(33.3, 1);
  });

  it('returns coveragePercent=0 (not NaN) when there are no routes', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const r = await computeRescueCoverage();

    expect(r.totalRoutes).toBe(0);
    expect(r.coveragePercent).toBe(0);
    expect(Number.isNaN(r.coveragePercent)).toBe(false);
  });

  it('queries only v_kamchatka_routes_api', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await computeRescueCoverage();
    const sql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sql).toContain('v_kamchatka_routes_api');
  });
});
