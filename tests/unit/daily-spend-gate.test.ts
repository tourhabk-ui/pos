/**
 * Жёсткий стоп дневного бюджета LLM: без вызова модели, с коротким кэшем.
 * Платных вызовов в этом файле нет — чтение суммы подменяется.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Побочная запись закрытия стопа в ядро (PR 1a серии «ядро») подменена:
// ни БД, ни Telegram здесь нет.
const kernelBudget = vi.hoisted(() => ({
  recordBudgetStop: vi.fn(async () => ({ first: false, throttled: true, taskId: null, spentUsd: null, dayKey: null })),
  ensureBudgetAlert: vi.fn(async () => ({ status: 'skipped' })),
}));
vi.mock('@/lib/agents/kernel/llm-budget', () => kernelBudget);

import {
  assertDailyLlmBudget,
  cachedLlmSpendToday,
  configureDailySpendGateForTests,
  isDailyBudgetStopped,
  isDailyLlmBudgetStopped,
  KUZMICH_DAILY_REST_TEXT,
  SPEND_CACHE_MS,
  DailyBudgetStopped,
  readDailyBudgetSnapshot,
} from '@/lib/ai/daily-spend-gate';

let savedKernel: string | undefined;
beforeEach(() => {
  configureDailySpendGateForTests(null);
  savedKernel = process.env.LLM_BUDGET_KERNEL;
  delete process.env.LLM_BUDGET_KERNEL;
  kernelBudget.recordBudgetStop.mockClear();
  kernelBudget.ensureBudgetAlert.mockClear();
});

afterEach(() => {
  configureDailySpendGateForTests(null);
  if (savedKernel === undefined) delete process.env.LLM_BUDGET_KERNEL; else process.env.LLM_BUDGET_KERNEL = savedKernel;
});

describe('снимок бюджета для ядра (PR 1a серии «ядро»)', () => {
  it('согласован со стопом на порогах $4,99 и $5', async () => {
    for (const [spent, stopped] of [[4.99, false], [5, true]] as const) {
      configureDailySpendGateForTests({ readSpendToday: async () => spent, budgetUsd: () => 5 });
      expect(await readDailyBudgetSnapshot()).toEqual({ spentUsd: spent, limitUsd: 5, stopped });
      configureDailySpendGateForTests({ readSpendToday: async () => spent, budgetUsd: () => 5 });
      expect(await isDailyLlmBudgetStopped()).toBe(stopped);
    }
  });

  it('стоп по-прежнему бросает DailyBudgetStopped с прежним текстом Кузьмича', async () => {
    configureDailySpendGateForTests({ readSpendToday: async () => 6, budgetUsd: () => 5 });
    await expect(assertDailyLlmBudget()).rejects.toBeInstanceOf(DailyBudgetStopped);
    expect(KUZMICH_DAILY_REST_TEXT).toBe(
      'Кузьмич на сегодня отдыхает. Заявку можно оставить на сайте — оператор свяжется. Если вы в опасности — звоните 112.');
  });

  it('закрытый стоп пишет факт в ядро, не дожидаясь записи; открытый — не пишет', async () => {
    let release!: () => void;
    kernelBudget.recordBudgetStop.mockImplementationOnce(() => new Promise((r) => {
      release = () => r({ first: true, throttled: false, taskId: 't-1', spentUsd: 6, dayKey: '2026-11-29' });
    }));
    configureDailySpendGateForTests({ readSpendToday: async () => 6, budgetUsd: () => 5 });
    // Запись висит, а ответ стопа уже есть.
    expect(await isDailyLlmBudgetStopped()).toBe(true);
    await vi.waitFor(() => expect(kernelBudget.recordBudgetStop).toHaveBeenCalledWith({ limitUsd: 5, trigger: 'gate' }));
    expect(kernelBudget.ensureBudgetAlert).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(kernelBudget.ensureBudgetAlert).toHaveBeenCalledWith({
      taskId: 't-1', spentUsd: 6, limitUsd: 5, runnerSpentUsd: null, mode: 'gate',
    }));
    kernelBudget.recordBudgetStop.mockClear();
    configureDailySpendGateForTests({ readSpendToday: async () => 4, budgetUsd: () => 5 });
    expect(await isDailyLlmBudgetStopped()).toBe(false);
    await new Promise((r) => setTimeout(r, 10));
    expect(kernelBudget.recordBudgetStop).not.toHaveBeenCalled();
  });

  it('ответ ядра из троттлинга — путь стопа алерт не трогает', async () => {
    kernelBudget.recordBudgetStop.mockResolvedValueOnce({ first: false, throttled: true, taskId: 't-1', spentUsd: 6, dayKey: '2026-11-29' });
    configureDailySpendGateForTests({ readSpendToday: async () => 6, budgetUsd: () => 5 });
    expect(await isDailyLlmBudgetStopped()).toBe(true);
    await vi.waitFor(() => expect(kernelBudget.recordBudgetStop).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(kernelBudget.ensureBudgetAlert).not.toHaveBeenCalled();
  });

  it('запись в ядро упала — стоп отвечает и бросает как прежде, ошибка только в лог', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    kernelBudget.recordBudgetStop.mockRejectedValueOnce(new Error('kernel down'));
    configureDailySpendGateForTests({ readSpendToday: async () => 6, budgetUsd: () => 5 });
    await expect(assertDailyLlmBudget()).rejects.toBeInstanceOf(DailyBudgetStopped);
    await vi.waitFor(() => expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('не записано в ядро'), 'kernel down'));
    errSpy.mockRestore();
  });

  it('LLM_BUDGET_KERNEL=off — стоп работает, в ядро ничего не идёт', async () => {
    process.env.LLM_BUDGET_KERNEL = 'off';
    configureDailySpendGateForTests({ readSpendToday: async () => 6, budgetUsd: () => 5 });
    await expect(assertDailyLlmBudget()).rejects.toBeInstanceOf(DailyBudgetStopped);
    await new Promise((r) => setTimeout(r, 10));
    expect(kernelBudget.recordBudgetStop).not.toHaveBeenCalled();
  });
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
