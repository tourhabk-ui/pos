import { describe, it, expect } from 'vitest';
import { summarizeFaithfulness, decideAlert, type EvalCase } from '@/lib/agents/eval/kuzmich-faithfulness';

function mkCase(id: string, score: number | null, overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id,
    category: 'safety',
    question: `q-${id}`,
    answer: score === null ? null : `answer-${id}`,
    context_len: 100,
    score,
    reason: 'test',
    ...overrides,
  };
}

describe('summarizeFaithfulness', () => {
  it('computes pass_rate and Wilson CI only over judged (non-null) cases', () => {
    const cases = [mkCase('a', 5), mkCase('b', 4), mkCase('c', 3), mkCase('d', null)];
    const r = summarizeFaithfulness(cases);
    expect(r.asked).toBe(4);
    expect(r.judged).toBe(3); // 'd' excluded (score null)
    expect(r.pass_rate).toBeCloseTo(2 / 3, 3); // a,b pass (>=4), c does not
    expect(r.wilson_low).toBeGreaterThanOrEqual(0);
    expect(r.wilson_high).toBeLessThanOrEqual(1);
    expect(r.judge_unavailable_ratio).toBeCloseTo(0.25, 3);
  });

  it('handles an empty set without dividing by zero', () => {
    const r = summarizeFaithfulness([]);
    expect(r.asked).toBe(0);
    expect(r.judged).toBe(0);
    expect(r.pass_rate).toBe(0);
    expect(r.judge_unavailable_ratio).toBe(1);
  });

  it('gives judge_unavailable_ratio 0 when every question got a verdict', () => {
    const r = summarizeFaithfulness([mkCase('a', 5), mkCase('b', 5)]);
    expect(r.judge_unavailable_ratio).toBe(0);
    expect(r.pass_rate).toBe(1);
  });

  it('a fabricated safety fact (score <= 2) is excluded from "passed" and drags pass_rate down', () => {
    // Симулирует ответ с выдуманным фактом безопасности ("брод проходим", которого
    // нет в приложенном контексте) — судья по промпту FAITHFULNESS_JUDGE_SYSTEM
    // должен был бы дать этому <=2. Здесь фиксируем контракт агрегации: такой
    // случай НЕ считается passed и тянет pass_rate вниз, а не игнорируется.
    const fabricated = mkCase('fabricated-hazard', 1, {
      question: 'Проходим ли брод у Толбачика?',
      reason: 'выдуман факт безопасности — брод не упомянут в контексте',
    });
    const cases = [mkCase('a', 5), mkCase('b', 5), mkCase('c', 5), fabricated];
    const r = summarizeFaithfulness(cases);
    expect(r.judged).toBe(4);
    expect(r.pass_rate).toBeCloseTo(3 / 4, 3);
    expect(fabricated.score).toBeLessThanOrEqual(2);
  });
});

describe('decideAlert', () => {
  it('alerts when judge_unavailable_ratio exceeds 30%', () => {
    const cases = [mkCase('a', 5), mkCase('b', null), mkCase('c', null), mkCase('d', null)];
    const summary = summarizeFaithfulness(cases);
    const alert = decideAlert(summary);
    expect(alert).not.toBeNull();
    expect(alert).toContain('судья недоступен');
  });

  it('alerts when pass_rate is below 0.8 among judged cases', () => {
    const cases = [mkCase('a', 2), mkCase('b', 3), mkCase('c', 5), mkCase('d', 5), mkCase('e', 5)];
    const summary = summarizeFaithfulness(cases);
    expect(summary.pass_rate).toBeLessThan(0.8);
    const alert = decideAlert(summary);
    expect(alert).not.toBeNull();
    expect(alert).toContain('faithfulness');
  });

  it('does not alert when pass_rate is at or above 0.8 and judge coverage is good', () => {
    const cases = [mkCase('a', 5), mkCase('b', 5), mkCase('c', 5), mkCase('d', 4), mkCase('e', 5)];
    const summary = summarizeFaithfulness(cases);
    expect(decideAlert(summary)).toBeNull();
  });

  it('does not alert on an empty run (nothing asked)', () => {
    const summary = summarizeFaithfulness([]);
    // asked=0 — судья "недоступен" на 100%, но нечего было спрашивать: не шумим
    expect(decideAlert(summary)).toBeNull();
  });
});
