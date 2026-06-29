import { describe, it, expect } from 'vitest';
import { scoreGeneration, summarizeRegression, type RegressionCase } from '@/lib/agents/eval/editor-regression';

describe('scoreGeneration', () => {
  it('passes only when text meets the length contract', () => {
    expect(scoreGeneration('a'.repeat(300))).toBe(true);
    expect(scoreGeneration('a'.repeat(299))).toBe(false);
    expect(scoreGeneration(null)).toBe(false);
    expect(scoreGeneration('   ')).toBe(false);
  });

  it('honours a custom minimum', () => {
    expect(scoreGeneration('a'.repeat(50), 50)).toBe(true);
    expect(scoreGeneration('a'.repeat(49), 50)).toBe(false);
  });
});

describe('summarizeRegression', () => {
  const mk = (n: number, passed: boolean): RegressionCase[] =>
    Array.from({ length: n }, (_, i) => ({ id: `id${i}`, title: `t${i}`, generated_len: passed ? 400 : 0, passed }));

  it('computes TSR and a Wilson interval bracketing it', () => {
    const r = summarizeRegression([...mk(8, true), ...mk(2, false)]);
    expect(r.total).toBe(10);
    expect(r.passed).toBe(8);
    expect(r.tsr).toBe(0.8);
    expect(r.ci.low).toBeGreaterThan(0);
    expect(r.ci.low).toBeLessThan(0.8);
    expect(r.ci.high).toBeGreaterThan(0.8);
    expect(r.ci.high).toBeLessThanOrEqual(1);
  });

  it('handles an empty set without dividing by zero', () => {
    const r = summarizeRegression([]);
    expect(r.total).toBe(0);
    expect(r.tsr).toBe(0);
    expect(r.ci).toEqual({ low: 0, high: 0 });
  });

  it('perfect run gives tsr 1 and upper bound 1', () => {
    const r = summarizeRegression(mk(5, true));
    expect(r.tsr).toBe(1);
    expect(r.ci.high).toBe(1);
  });

  it('aggregates judge quality when cases carry quality_score', () => {
    const cases: RegressionCase[] = [
      { id: 'a', title: 'a', generated_len: 400, passed: true, quality_score: 5 },
      { id: 'b', title: 'b', generated_len: 400, passed: true, quality_score: 4 },
      { id: 'c', title: 'c', generated_len: 350, passed: true, quality_score: 2 },
      { id: 'd', title: 'd', generated_len: 400, passed: true }, // не оценён судьёй
    ];
    const r = summarizeRegression(cases);
    expect(r.judged).toBe(3);
    expect(r.quality_avg).toBeCloseTo((5 + 4 + 2) / 3, 2);
    expect(r.quality_good).toBe(2); // >=4
  });

  it('omits quality fields when no case was judged', () => {
    const r = summarizeRegression(mk(3, true));
    expect(r.judged).toBeUndefined();
    expect(r.quality_avg).toBeUndefined();
  });
});
