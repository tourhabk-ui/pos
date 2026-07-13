/**
 * Фоллбэк провайдера у судьи (judgeWithFallback).
 *
 * Контракт: score=null («судья недоступен») ставится ТОЛЬКО когда и быстрый
 * набор (callAIFast), и полный waterfall (callAIWaterfall) не дали валидного
 * балла. Единичный отказ быстрого провайдера НЕ роняет оценку в null — её
 * добирает waterfall (другой набор провайдеров, включая Anthropic).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const callAIFast = vi.fn();
const callAIWaterfall = vi.fn();
// Реальная логика sentinel-детектора: важна, чтобы «Сервис временно недоступен»
// из быстрого набора триггерил фоллбэк, а не парсился как валидный ответ.
vi.mock('@/lib/ai/providers', () => ({
  callAIFast: (...a: unknown[]) => callAIFast(...a),
  callAIWaterfall: (...a: unknown[]) => callAIWaterfall(...a),
  isWaterfallErrorResponse: (t: string) =>
    t.startsWith('Извините, сервис временно недоступен') || t.startsWith('Сервис временно недоступен'),
}));

import { judgeWithFallback } from '@/lib/agents/eval/editor-judge';

describe('judgeWithFallback', () => {
  beforeEach(() => {
    callAIFast.mockReset();
    callAIWaterfall.mockReset();
  });

  it('быстрый набор дал балл — waterfall не вызывается', async () => {
    callAIFast.mockResolvedValue('рассуждение\n{"score": 5, "reason": "ok"}');
    const v = await judgeWithFallback('sys', 'user');
    expect(v.score).toBe(5);
    expect(callAIWaterfall).not.toHaveBeenCalled();
  });

  it('быстрый набор вернул sentinel-заглушку — добирает waterfall', async () => {
    callAIFast.mockResolvedValue('Сервис временно недоступен.');
    callAIWaterfall.mockResolvedValue('{"score": 4, "reason": "fallback"}');
    const v = await judgeWithFallback('sys', 'user');
    expect(v.score).toBe(4);
    expect(callAIWaterfall).toHaveBeenCalledTimes(1);
  });

  it('быстрый набор вернул нераспознаваемый балл — добирает waterfall', async () => {
    callAIFast.mockResolvedValue('никакой оценки тут нет');
    callAIWaterfall.mockResolvedValue('{"score": 3, "reason": "fallback"}');
    const v = await judgeWithFallback('sys', 'user');
    expect(v.score).toBe(3);
    expect(callAIWaterfall).toHaveBeenCalledTimes(1);
  });

  it('быстрый набор бросил исключение — добирает waterfall', async () => {
    callAIFast.mockRejectedValue(new Error('network'));
    callAIWaterfall.mockResolvedValue('{"score": 5}');
    const v = await judgeWithFallback('sys', 'user');
    expect(v.score).toBe(5);
    expect(callAIWaterfall).toHaveBeenCalledTimes(1);
  });

  it('оба набора недоступны — честный null «судья недоступен»', async () => {
    callAIFast.mockResolvedValue('Сервис временно недоступен.');
    callAIWaterfall.mockResolvedValue('Извините, сервис временно недоступен. Попробуйте позже.');
    const v = await judgeWithFallback('sys', 'user');
    expect(v.score).toBeNull();
    expect(v.reason).toContain('судья недоступен');
  });

  it('оба набора бросили — null, харнесс не падает', async () => {
    callAIFast.mockRejectedValue(new Error('fast down'));
    callAIWaterfall.mockRejectedValue(new Error('waterfall down'));
    const v = await judgeWithFallback('sys', 'user');
    expect(v.score).toBeNull();
  });
});
