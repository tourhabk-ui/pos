import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPoolQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}));

import { ExperimentTracker, wilsonInterval } from '@/lib/agents/learning/experiment-tracker';

beforeEach(() => vi.clearAllMocks());

describe('wilsonInterval', () => {
  it('returns {0,0} for zero trials', () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 0 });
  });

  it('brackets the point estimate and stays within [0,1]', () => {
    const ci = wilsonInterval(50, 100);
    expect(ci.low).toBeGreaterThan(0.39);
    expect(ci.low).toBeLessThan(0.5);
    expect(ci.high).toBeGreaterThan(0.5);
    expect(ci.high).toBeLessThan(0.61);
  });

  it('is wide for small N (high uncertainty)', () => {
    const small = wilsonInterval(2, 3);
    const large = wilsonInterval(200, 300);
    expect(small.high - small.low).toBeGreaterThan(large.high - large.low);
  });

  it('clamps at the boundaries (never exceeds [0,1])', () => {
    const all = wilsonInterval(10, 10);
    expect(all.high).toBeLessThanOrEqual(1);
    expect(all.low).toBeGreaterThanOrEqual(0);
  });
});

describe('pickVariant', () => {
  const t = new ExperimentTracker();

  it('is deterministic for the same stable key', () => {
    const a = t.pickVariant('exp1', 'user-42');
    const b = t.pickVariant('exp1', 'user-42');
    expect(a).toBe(b);
  });

  it('returns a or b without a key (random, unbiased)', () => {
    const v = t.pickVariant('exp1');
    expect(['a', 'b']).toContain(v);
  });

  it('spreads keys across both variants (not all one side)', () => {
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 200; i++) counts[t.pickVariant('exp1', `k${i}`)]++;
    expect(counts.a).toBeGreaterThan(40);
    expect(counts.b).toBeGreaterThan(40);
  });
});

describe('calculateResults winner logic (Wilson, non-overlapping CIs)', () => {
  function mockCounts(aS: number, aF: number, bS: number, bF: number) {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { variant: 'a', outcome: 'success', count: String(aS) },
        { variant: 'a', outcome: 'fail', count: String(aF) },
        { variant: 'b', outcome: 'success', count: String(bS) },
        { variant: 'b', outcome: 'fail', count: String(bF) },
      ],
    });
  }

  it('declares no winner when intervals overlap (small/close samples)', async () => {
    mockCounts(6, 4, 5, 5); // 60% vs 50%, N=10 each → CIs overlap
    const r = await new ExperimentTracker().calculateResults('e');
    expect(r.winner).toBe('tie');
  });

  it('declares a winner only when CIs are clearly separated', async () => {
    mockCounts(95, 5, 30, 70); // 95% vs 30%, N=100 each → no overlap
    const r = await new ExperimentTracker().calculateResults('e');
    expect(r.winner).toBe('a');
  });

  it('returns null winner below the minimum sample size', async () => {
    mockCounts(3, 1, 1, 1); // totals < 10
    const r = await new ExperimentTracker().calculateResults('e');
    expect(r.winner).toBeNull();
  });
});
