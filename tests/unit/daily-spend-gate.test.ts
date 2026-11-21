/**
 * Жёсткий стоп дневного бюджета LLM: без вызова модели, с коротким кэшем.
 * Платных вызовов в этом файле нет — чтение суммы подменяется.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  assertDailyLlmBudget,
  cachedLlmSpendToday,
  configureDailySpendGateForTests,
  isDailyBudgetStopped,
  isDailyLlmBudgetStopped,
  KUZMICH_DAILY_REST_TEXT,
  SPEND_CACHE_MS,
  DailyBudgetStopped,
} from '@/lib/ai/daily-spend-gate';

beforeEach(() => {
  configureDailySpendGateForTests(null);
});

afterEach(() => {
  configureDailySpendGateForTests(null);
});

describe('isDailyLlmBudgetStopped', () => {
  it('при сумме ниже порога $5 вызов разрешён', async () => {
    configureDailySpendGateForTests({
      readSpendToday: async () => 4.99,
      budgetUsd: () => 5,
    });
    expect(await isDailyLlmBudgetStopped()).toBe(false);
    await expect(assertDailyLlmBudget()).resolves.toBeUndefined();
  });

  it('при сумме равной или выше порога — стоп, без повторного чтения в окне кэша', async () => {
    let reads = 0;
    configureDailySpendGateForTests({
      now: () => 1_000,
      readSpendToday: async () => {
        reads += 1;
        return 5;
      },
      budgetUsd: () => 5,
    });
    expect(await isDailyLlmBudgetStopped()).toBe(true);
    expect(await isDailyLlmBudgetStopped()).toBe(true);
    expect(reads).toBe(1);
    await expect(assertDailyLlmBudget()).rejects.toSatisfy((err: unknown) => isDailyBudgetStopped(err));
  });

  it('после истечения кэша сумма читается снова', async () => {
    let now = 1_000;
    let spend = 1;
    configureDailySpendGateForTests({
      now: () => now,
      readSpendToday: async () => spend,
      budgetUsd: () => 5,
    });
    expect(await isDailyLlmBudgetStopped()).toBe(false);
    spend = 9;
    now += SPEND_CACHE_MS + 1;
    expect(await isDailyLlmBudgetStopped()).toBe(true);
  });

  it('ошибка чтения книги не закрывает шлюз всем', async () => {
    configureDailySpendGateForTests({
      readSpendToday: async () => {
        throw new Error('db down');
      },
      budgetUsd: () => 5,
    });
    expect(await isDailyLlmBudgetStopped()).toBe(false);
  });
});

describe('текст для человека', () => {
  it('честно говорит про отдых и заявку, без «база ограничена»', () => {
    expect(KUZMICH_DAILY_REST_TEXT).toMatch(/отдыхает/);
    expect(KUZMICH_DAILY_REST_TEXT).toMatch(/заявку можно оставить на сайте/i);
    expect(KUZMICH_DAILY_REST_TEXT).toMatch(/оператор свяжется/i);
    expect(KUZMICH_DAILY_REST_TEXT).toMatch(/112/);
    expect(KUZMICH_DAILY_REST_TEXT).not.toMatch(/база|временно ограничен|сбой|недоступн/i);
    expect(new DailyBudgetStopped().message).toBe(KUZMICH_DAILY_REST_TEXT);
  });
});

describe('кэш не бьёт читалку на каждом вызове', () => {
  it('cachedLlmSpendToday повторяет сумму внутри окна', async () => {
    let reads = 0;
    configureDailySpendGateForTests({
      now: () => 5_000,
      readSpendToday: async () => {
        reads += 1;
        return 2.5;
      },
    });
    expect(await cachedLlmSpendToday()).toBe(2.5);
    expect(await cachedLlmSpendToday()).toBe(2.5);
    expect(reads).toBe(1);
  });
});
