import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildCompactionTranscript, summarizeDroppedTurns } from '@/lib/kuzmich/history-compaction';
import type { ChatMessage } from '@/lib/ai/prompts';

const mockCallAIFast = vi.fn();
vi.mock('@/lib/ai/providers', () => ({
  callAIFast: (...args: unknown[]) => mockCallAIFast(...args),
}));

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content };
}

describe('buildCompactionTranscript', () => {
  it('renders user/assistant turns with Russian role labels', () => {
    const t = buildCompactionTranscript([msg('user', 'Расскажи про Толбачик'), msg('assistant', 'Это вулкан')]);
    expect(t).toContain('Турист: Расскажи про Толбачик');
    expect(t).toContain('Кузьмич: Это вулкан');
  });

  it('excludes system messages from the transcript', () => {
    const t = buildCompactionTranscript([msg('system', 'служебное'), msg('user', 'вопрос')]);
    expect(t).not.toContain('служебное');
    expect(t).toContain('вопрос');
  });

  it('returns empty string for an empty input', () => {
    expect(buildCompactionTranscript([])).toBe('');
  });

  it('caps the overall transcript length', () => {
    const long = Array.from({ length: 50 }, (_, i) => msg('user', `сообщение номер ${i} `.repeat(20)));
    const t = buildCompactionTranscript(long);
    expect(t.length).toBeLessThanOrEqual(4000);
  });
});

describe('summarizeDroppedTurns', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty string without calling the judge when nothing was dropped', async () => {
    const r = await summarizeDroppedTurns([]);
    expect(r).toBe('');
    expect(mockCallAIFast).not.toHaveBeenCalled();
  });

  it('returns the summary when the judge finds durable facts', async () => {
    mockCallAIFast.mockResolvedValue('Турист планирует поход на Толбачик в августе с двумя детьми.');
    const r = await summarizeDroppedTurns([msg('user', 'Мы с двумя детьми хотим на Толбачик в августе')]);
    expect(r).toContain('Толбачик');
    expect(mockCallAIFast).toHaveBeenCalledTimes(1);
  });

  it('normalizes an explicit "нет" verdict to an empty string (fail-open, not a fake summary)', async () => {
    mockCallAIFast.mockResolvedValue('нет');
    const r = await summarizeDroppedTurns([msg('user', 'привет')]);
    expect(r).toBe('');
  });

  it('is fail-open on judge errors — never throws, never blocks the caller', async () => {
    mockCallAIFast.mockRejectedValue(new Error('waterfall down'));
    const r = await summarizeDroppedTurns([msg('user', 'привет')]);
    expect(r).toBe('');
  });

  it('truncates an overly long summary instead of letting it dominate the prompt', async () => {
    mockCallAIFast.mockResolvedValue('а'.repeat(2000));
    const r = await summarizeDroppedTurns([msg('user', 'привет')]);
    expect(r.length).toBe(500);
  });
});
