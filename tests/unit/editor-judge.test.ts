import { describe, it, expect, vi } from 'vitest';

// judge module imports callAIFast at load — stub the providers module
vi.mock('@/lib/ai/providers', () => ({ callAIFast: vi.fn() }));

import { parseJudgeScore } from '@/lib/agents/eval/editor-judge';

describe('parseJudgeScore', () => {
  it('reads score from JSON verdict', () => {
    expect(parseJudgeScore('{"score": 4, "reason": "ok"}')).toBe(4);
    expect(parseJudgeScore('рассуждение тут\n{"score":5,"reason":"отлично"}')).toBe(5);
  });

  it('clamps out-of-range scores into 1..5', () => {
    expect(parseJudgeScore('{"score": 9}')).toBe(5);
    expect(parseJudgeScore('{"score": 0}')).toBe(1);
    expect(parseJudgeScore('{"score": 3.6}')).toBe(4); // округление
  });

  it('falls back to a standalone 1-5 digit when no JSON', () => {
    expect(parseJudgeScore('итоговая оценка: 3 из 5')).toBe(3);
  });

  it('returns null when nothing parseable', () => {
    expect(parseJudgeScore('нет оценки')).toBeNull();
    expect(parseJudgeScore('')).toBeNull();
  });
});
