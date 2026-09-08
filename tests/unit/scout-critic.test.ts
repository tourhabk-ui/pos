/**
 * Критик предложений: три исхода, не два (issue #1724).
 *
 * Fail-open остаётся политикой — гейт не имеет права обнулить выдачу, когда
 * критик молчит. Дефект был в другом: «одобрено» и «не смог оценить»
 * приходили вызывающему одинаковым `approved: true`, а разница жила в строке
 * reason, которую никто не разбирал. Issue по неоценённому предложению
 * выглядел точно так же, как прошедший ревью.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mockCallAIFast = vi.fn();
vi.mock('@/lib/ai/providers', () => ({
  callAIFast: (...args: unknown[]) => mockCallAIFast(...args),
  callAIWithModel: vi.fn(),
}));

import { criticReviewProposal, criticPasses } from '@/lib/agents/scout-innovator';

const PROPOSAL = {
  title: 'Добавить кэш для маршрутов',
  why: 'Ускорить выдачу',
  files_to_change: ['lib/foo.ts'],
  implementation_steps: ['шаг 1'],
  acceptance_criteria: ['кэш работает'],
  complexity: 'small' as const,
  category: 'performance' as const,
};

beforeEach(() => vi.clearAllMocks());

describe('criticReviewProposal', () => {
  it('явное approved=false — отказ', async () => {
    mockCallAIFast.mockResolvedValue('{"approved": false, "reason": "трогает payments"}');
    const v = await criticReviewProposal(PROPOSAL, 'rules', 'closed', 'libs');
    expect(v.verdict).toBe('rejected');
    expect(v.reason).toContain('payments');
    expect(criticPasses(v)).toBe(false);
  });

  it('явное approved=true — одобрено', async () => {
    mockCallAIFast.mockResolvedValue('тут текст {"approved": true, "reason": "ок"} и ещё');
    const v = await criticReviewProposal(PROPOSAL, 'rules', 'closed', 'libs');
    expect(v.verdict).toBe('approved');
    expect(criticPasses(v)).toBe(true);
  });

  it('ответ без JSON — «не смог оценить», а НЕ одобрение', async () => {
    mockCallAIFast.mockResolvedValue('извини, не понял');
    const v = await criticReviewProposal(PROPOSAL, 'rules', 'closed', 'libs');
    expect(v.verdict).toBe('unknown');
    // Политика прежняя: поток не блокируется.
    expect(criticPasses(v)).toBe(true);
  });

  it('модель бросила — «не смог оценить», поток не обнуляется', async () => {
    mockCallAIFast.mockRejectedValue(new Error('egress flicker'));
    const v = await criticReviewProposal(PROPOSAL, 'rules', 'closed', 'libs');
    expect(v.verdict).toBe('unknown');
    expect(v.reason).toContain('egress');
    expect(criticPasses(v)).toBe(true);
  });

  it('поля approved нет — вердикта не было, значит unknown', async () => {
    // Раньше это считалось одобрением: «отклоняет только явное false».
    mockCallAIFast.mockResolvedValue('{"reason": "нет поля approved"}');
    const v = await criticReviewProposal(PROPOSAL, 'rules', 'closed', 'libs');
    expect(v.verdict).toBe('unknown');
    expect(criticPasses(v)).toBe(true);
  });
});

describe('непроверенность видна человеку, а не только типу', () => {
  const SRC = readFileSync(join(process.cwd(), 'lib/agents/scout-innovator.ts'), 'utf8');

  it('тело issue несёт пометку «критик не смог оценить»', () => {
    expect(SRC).toMatch(/Критик НЕ СМОГ оценить это предложение/);
    expect(SRC).toMatch(/uncheckedReason/);
  });

  it('подпись issue тоже помечена', () => {
    expect(SRC).toMatch(/БЕЗ РЕВЬЮ КРИТИКА/);
  });

  it('немота критика попадает в лог', () => {
    expect(SRC).toMatch(/logSwallowedFailure\('scout-innovator', 'критик предложений'/);
  });
});
