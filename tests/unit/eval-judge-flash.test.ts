/**
 * Судья эвала идёт сперва одним дешёвым вызовом DeepSeek flash (03.11),
 * гонка четырёх провайдеров и водопад — только фоллбэк.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  fastModel: 'deepseek-v4-flash' as string | null,
  deepseek: vi.fn(),
  fast: vi.fn(),
  waterfall: vi.fn(),
}));

vi.mock('@/lib/ai/providers', () => ({
  callAICheap: async (m: unknown, o: unknown) => (h.fastModel ? h.deepseek(m, { ...(o as object), deepseekModel: h.fastModel }) : null),
  callAIFast: h.fast,
  callAIWaterfall: h.waterfall,
  isWaterfallErrorResponse: (s: string) => s.startsWith('Сервис временно недоступен'),
}));

import { judgeWithFallback } from '@/lib/agents/eval/editor-judge';

beforeEach(() => {
  h.fastModel = 'deepseek-v4-flash';
  h.deepseek.mockReset(); h.fast.mockReset(); h.waterfall.mockReset();
});

describe('judgeWithFallback', () => {
  it('flash ответил баллом — гонка и водопад не вызываются', async () => {
    h.deepseek.mockResolvedValue('ok {"score": 4, "reason": "x"}');
    const v = await judgeWithFallback('sys', 'user');
    expect(v.score).toBe(4);
    expect(h.deepseek).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ deepseekModel: 'deepseek-v4-flash' }));
    expect(h.fast).not.toHaveBeenCalled();
    expect(h.waterfall).not.toHaveBeenCalled();
  });

  it('flash молчит — прежний путь (гонка), качество не теряется', async () => {
    h.deepseek.mockResolvedValue(null);
    h.fast.mockResolvedValue('{"score": 2}');
    expect((await judgeWithFallback('s', 'u')).score).toBe(2);
  });

  it('flash не найден в каталоге — сразу прежний путь', async () => {
    h.fastModel = null;
    h.fast.mockResolvedValue('{"score": 5}');
    expect((await judgeWithFallback('s', 'u')).score).toBe(5);
    expect(h.deepseek).not.toHaveBeenCalled();
  });

  it('все молчат — честное «судья недоступен»', async () => {
    h.deepseek.mockResolvedValue(null);
    h.fast.mockResolvedValue('Сервис временно недоступен');
    h.waterfall.mockRejectedValue(new Error('x'));
    expect((await judgeWithFallback('s', 'u')).score).toBeNull();
  });
});
