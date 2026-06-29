import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCallAIFast = vi.fn();
vi.mock('@/lib/ai/providers', () => ({
  callAIFast: (...args: unknown[]) => mockCallAIFast(...args),
  callAIWithModel: vi.fn(),
}));

import { criticReviewProposal } from '@/lib/agents/scout-innovator';

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
  it('rejects when the model says approved=false', async () => {
    mockCallAIFast.mockResolvedValue('{"approved": false, "reason": "трогает payments"}');
    const v = await criticReviewProposal(PROPOSAL, 'rules', 'closed', 'libs');
    expect(v.approved).toBe(false);
    expect(v.reason).toContain('payments');
  });

  it('approves when the model says approved=true', async () => {
    mockCallAIFast.mockResolvedValue('тут текст {"approved": true, "reason": "ок"} и ещё');
    const v = await criticReviewProposal(PROPOSAL, 'rules', 'closed', 'libs');
    expect(v.approved).toBe(true);
  });

  it('fail-open: malformed (no JSON) response → approved', async () => {
    mockCallAIFast.mockResolvedValue('извини, не понял');
    const v = await criticReviewProposal(PROPOSAL, 'rules', 'closed', 'libs');
    expect(v.approved).toBe(true);
    expect(v.reason).toContain('fail-open');
  });

  it('fail-open: AI throws → approved (gate never zeroes the pipeline)', async () => {
    mockCallAIFast.mockRejectedValue(new Error('egress flicker'));
    const v = await criticReviewProposal(PROPOSAL, 'rules', 'closed', 'libs');
    expect(v.approved).toBe(true);
    expect(v.reason).toContain('fail-open');
  });

  it('only an explicit false rejects (missing field → approved)', async () => {
    mockCallAIFast.mockResolvedValue('{"reason": "нет поля approved"}');
    const v = await criticReviewProposal(PROPOSAL, 'rules', 'closed', 'libs');
    expect(v.approved).toBe(true);
  });
});
