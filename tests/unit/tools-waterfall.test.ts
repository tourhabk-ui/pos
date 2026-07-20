/**
 * Водопад инструментов Кузьмича: OpenRouter → DeepSeek. При регион-блоке
 * OpenRouter (403 → null) tools-цикл обязан упасть на DeepSeek, а не остаться
 * без инструментов. Тестируем чистую логику firstNonNullTool.
 */

import { describe, it, expect, vi } from 'vitest';
import { firstNonNullTool } from '@/lib/ai/providers';

const ok = (tag: string) => ({ content: tag, tool_calls: null });

describe('firstNonNullTool', () => {
  it('первый провайдер ответил → берём его, второй не зовём', async () => {
    const second = vi.fn(async () => ok('deepseek'));
    const r = await firstNonNullTool([
      async () => ok('openrouter'),
      second,
    ]);
    expect(r?.content).toBe('openrouter');
    expect(second).not.toHaveBeenCalled();
  });

  it('первый вернул null (регион-блок) → падаем на второй (DeepSeek)', async () => {
    const r = await firstNonNullTool([
      async () => null,
      async () => ok('deepseek'),
    ]);
    expect(r?.content).toBe('deepseek');
  });

  it('все null → null (нет доступных провайдеров с инструментами)', async () => {
    const r = await firstNonNullTool([
      async () => null,
      async () => null,
    ]);
    expect(r).toBeNull();
  });

  it('порядок соблюдается: зовём по очереди до первого успеха', async () => {
    const calls: string[] = [];
    const r = await firstNonNullTool([
      async () => { calls.push('a'); return null; },
      async () => { calls.push('b'); return ok('b'); },
      async () => { calls.push('c'); return ok('c'); },
    ]);
    expect(r?.content).toBe('b');
    expect(calls).toEqual(['a', 'b']);
  });
});
