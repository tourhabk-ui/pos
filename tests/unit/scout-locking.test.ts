import { describe, it, expect, vi } from 'vitest';

// scout-innovator imports providers at module load — stub them
vi.mock('@/lib/ai/providers', () => ({ callAIFast: vi.fn(), callAIWithModel: vi.fn() }));

import { isDuplicateTitle } from '@/lib/agents/scout-innovator';

describe('isDuplicateTitle', () => {
  it('flags a near-identical title as duplicate', () => {
    const existing = ['Добавить rate limiting для /api/ai/deepseek'];
    expect(isDuplicateTitle('Добавить rate limiting для /api/ai/deepseek', existing)).toBe(true);
  });

  it('flags a reworded but overlapping title', () => {
    const existing = ['LLM usage tracking и логирование токенов'];
    expect(isDuplicateTitle('Логирование токенов LLM usage tracking', existing)).toBe(true);
  });

  it('does not flag an unrelated title', () => {
    const existing = ['Добавить офлайн-карты для маршрутов'];
    expect(isDuplicateTitle('Telegram RAG-бот для гидов', existing)).toBe(false);
  });

  it('returns false against an empty lock set', () => {
    expect(isDuplicateTitle('что угодно', [])).toBe(false);
  });

  it('respects a custom threshold', () => {
    const existing = ['кэш маршрутов на сервере'];
    // частичное пересечение — при высоком пороге не считается дублем
    expect(isDuplicateTitle('кэш данных пользователя', existing, 0.9)).toBe(false);
  });
});
