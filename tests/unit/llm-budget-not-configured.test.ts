/**
 * Бюджет AI без порога — не «успех» (аудит перед запуском, 22.10).
 *
 * Крон без `AI_DAILY_BUDGET_USD` отвечал `ok: true, skipped` и писал успех в
 * журнал прогонов: workflow и панель кронов зеленели каждый час, а тревога о
 * перерасходе молчала при любой трате. Здесь — вызов роута на границах порога:
 * не задан, мусор, ноль и минус — отказ с причиной и траты дня в ответе;
 * задан — прежний успех. Причина постоянная: по её тексту Watchdog узнаёт
 * повтор и не шлёт его чаще раза в 12 часов.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { poolQuery, recordCronRun, notifyBudgetAlert, claimCronWindow } = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  recordCronRun: vi.fn(),
  notifyBudgetAlert: vi.fn(async () => ({ ok: true })),
  claimCronWindow: vi.fn(async (): Promise<'claimed' | 'held' | 'unknown'> => 'claimed'),
}));

vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));
// Ядро подменено: этот poolQuery не отдаёт ключ суток (запись стопа в ядро —
// tests/unit/kernel-llm-budget.test.ts). Старые случаи идут с
// LLM_BUDGET_KERNEL=off и прежними ожиданиями (уточнение ревью 5).
const kernelBudget = vi.hoisted(() => ({
  recordBudgetStop: vi.fn(async () => ({ first: true, throttled: false, taskId: 'task-day', spentUsd: 5.4, dayKey: '2026-11-29' })),
  ensureBudgetAlert: vi.fn(async () => ({ status: 'sent' as string })),
}));
vi.mock('@/lib/agents/kernel/llm-budget', () => kernelBudget);

vi.mock('@/lib/agents/cron-heartbeat', () => ({ recordCronRun }));
vi.mock('@/lib/telegram/admin-notify', () => ({ notifyBudgetAlert }));
vi.mock('@/lib/agents/cron-lease', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agents/cron-lease')>('@/lib/agents/cron-lease');
  return { ...actual, claimCronWindow };
});

import { GET } from '@/app/api/cron/llm-budget-check/route';
import { readDailyBudget, BUDGET_UNSET_REASON, BUDGET_INVALID_REASON } from '@/lib/ai/daily-budget';

const envBefore = { ...process.env };
const call = () => GET(new Request('https://vedarai.ru/api/cron/llm-budget-check', {
  headers: { authorization: 'Bearer cron-test' },
}));

interface Body { ok: boolean; status: string; reason?: string; spent_usd?: number; limit_usd?: number }

beforeEach(() => {
  poolQuery.mockReset();
  recordCronRun.mockReset();
  notifyBudgetAlert.mockClear();
  claimCronWindow.mockReset();
  claimCronWindow.mockResolvedValue('claimed');
  poolQuery.mockResolvedValue({ rows: [{ spent: '3.25', unknown_calls: '0' }] });
  process.env.CRON_SECRET = 'cron-test';
  process.env.LLM_BUDGET_KERNEL = 'off';
  kernelBudget.recordBudgetStop.mockClear();
  kernelBudget.ensureBudgetAlert.mockClear();
});

afterEach(() => {
  process.env = { ...envBefore };
});

describe('порог дневного бюджета: три исхода', () => {
  it('пусто — «не задан», мусор, ноль и минус — «не число», число — порог', () => {
    expect(readDailyBudget(undefined)).toEqual({ kind: 'unset' });
    expect(readDailyBudget('  ')).toEqual({ kind: 'unset' });
    for (const bad of ['abc', '10abc', '0', '-5', 'NaN', 'Infinity']) {
      expect(readDailyBudget(bad), bad).toEqual({ kind: 'invalid' });
    }
    expect(readDailyBudget('10')).toEqual({ kind: 'set', usd: 10 });
    expect(readDailyBudget('7,5')).toEqual({ kind: 'set', usd: 7.5 });
  });
});

describe('GET /api/cron/llm-budget-check без порога', () => {
  it('не задан — отказ в журнале, траты дня в ответе, тревога о перерасходе не уходит', async () => {
    delete process.env.AI_DAILY_BUDGET_USD;
    const res = await call();
    const body = await res.json() as Body;
    expect(body).toMatchObject({ ok: false, status: 'not_configured', reason: BUDGET_UNSET_REASON, spent_usd: 3.25 });
    expect(recordCronRun).toHaveBeenCalledTimes(1);
    expect(recordCronRun).toHaveBeenCalledWith('llm-budget', expect.any(Number), 'failed', { error: BUDGET_UNSET_REASON });
    expect(notifyBudgetAlert).not.toHaveBeenCalled();
  });

  it('не число — тот же исход со своей причиной', async () => {
    process.env.AI_DAILY_BUDGET_USD = 'десять';
    const body = await (await call()).json() as Body;
    expect(body).toMatchObject({ ok: false, status: 'not_configured', reason: BUDGET_INVALID_REASON });
    expect(recordCronRun).toHaveBeenCalledWith('llm-budget', expect.any(Number), 'failed', { error: BUDGET_INVALID_REASON });
  });

  it('причина не зависит от трат — повтор узнаётся по тексту', async () => {
    delete process.env.AI_DAILY_BUDGET_USD;
    await call();
    poolQuery.mockResolvedValue({ rows: [{ spent: '41.70', unknown_calls: '3' }] });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await call();
    const errors = recordCronRun.mock.calls.map((c) => (c[3] as { error: string }).error);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBe(errors[1]);
  });

  it('без порога и при включённом ядре — по-прежнему ни алерта, ни записи в ядро (алерт стопа на $5 даёт путь стопа)', async () => {
    delete process.env.LLM_BUDGET_KERNEL;
    delete process.env.AI_DAILY_BUDGET_USD;
    poolQuery.mockResolvedValue({ rows: [{ spent: '41.70', unknown_calls: '0' }] });
    const body = await (await call()).json() as Body;
    expect(body).toMatchObject({ ok: false, status: 'not_configured' });
    expect(notifyBudgetAlert).not.toHaveBeenCalled();
    expect(kernelBudget.recordBudgetStop).not.toHaveBeenCalled();
    expect(kernelBudget.ensureBudgetAlert).not.toHaveBeenCalled();
  });

  it('порог задан — прежний путь: успех и сравнение с лимитом', async () => {
    process.env.AI_DAILY_BUDGET_USD = '10';
    const body = await (await call()).json() as Body;
    expect(body).toMatchObject({ ok: true, status: 'ok', spent_usd: 3.25, limit_usd: 10 });
    expect(recordCronRun).toHaveBeenCalledWith('llm-budget', expect.any(Number), 'success', { items: 1 });
    expect(notifyBudgetAlert).not.toHaveBeenCalled();
  });

  it('порог задан и превышен — тревога уходит', async () => {
    process.env.AI_DAILY_BUDGET_USD = '2';
    const body = await (await call()).json() as Body;
    expect(body.status).toBe('alert_sent');
    // Третье число — расход раннера GitHub (в лимит не входит, 23.11); строки раннера в моке нет.
    expect(notifyBudgetAlert).toHaveBeenCalledWith(3.25, 2, 0);
  });
});

describe('GET /api/cron/llm-budget-check: окно занято', () => {
  it('пропуск аренды — не замер: журнал пуст, тело называет lease_held, HTTP 200', async () => {
    claimCronWindow.mockResolvedValue('held');
    process.env.AI_DAILY_BUDGET_USD = '10';
    const res = await call();
    const body = await res.json() as { success?: boolean; skipped?: string; agent_id?: string };
    expect(res.status).toBe(200);
    expect(body.skipped).toBe('lease_held');
    expect(body.success).toBe(true);
    expect(body.agent_id).toBe('llm-budget');
    expect(recordCronRun).not.toHaveBeenCalled();
    expect(poolQuery).not.toHaveBeenCalled();
    expect(notifyBudgetAlert).not.toHaveBeenCalled();
  });
});
