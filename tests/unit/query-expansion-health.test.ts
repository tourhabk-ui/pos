import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeQueryExpansionHealth } from '@/lib/services/query-expansion-health';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

describe('computeQueryExpansionHealth (issue #250 — multi-query RAG effect)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('computes avgExpanded and pctWithNewResults from the 7-day aggregate', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ total: '10', avg_expanded: '2.5', with_new_results: '4' }],
    });

    const health = await computeQueryExpansionHealth();

    expect(health.totalLogged).toBe(10);
    expect(health.avgExpanded).toBe(2.5);
    expect(health.pctWithNewResults).toBe(40);
  });

  it('returns zeros (not NaN) when no rows are logged yet', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ total: '0', avg_expanded: null, with_new_results: '0' }],
    });

    const health = await computeQueryExpansionHealth();

    expect(health.totalLogged).toBe(0);
    expect(health.avgExpanded).toBe(0);
    expect(health.pctWithNewResults).toBe(0);
    expect(Number.isNaN(health.pctWithNewResults)).toBe(false);
  });

  it('queries only the last 7 days', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '1', avg_expanded: '1', with_new_results: '0' }] });

    await computeQueryExpansionHealth();

    const sql = mockQuery.mock.calls[0]![0] as string;
    expect(sql).toContain('query_expansion_log');
    expect(sql).toContain("INTERVAL '7 days'");
  });
});
