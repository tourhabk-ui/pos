/**
 * Суточный стоп считает только расход сайта (слово владельца 23.11 «1 да»).
 *
 * 23.11 стоп закрылся на $7,60 при пороге $5, а $7,02 из них дала проверка
 * безопасности PR на раннере GitHub: Кузьмич замолчал для туристов из-за
 * трат, к которым они отношения не имеют. Теперь стоп и крон тревоги
 * сверяют с порогом расход сайта, а расход раннера называют отдельно.
 *
 * Здесь — вызов роута крона и текст тревоги. Что SQL на настоящей базе
 * считает именно так (сайт, прежние строки без отметки, раннер мимо),
 * держит сцена «траты LLM за сутки» в tests/integration/admin-day-counts.pg.test.ts.
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
vi.mock('@/lib/telegram/admin-notify', async () => {
  const actual = await vi.importActual<typeof import('@/lib/telegram/admin-notify')>('@/lib/telegram/admin-notify');
  return { ...actual, notifyBudgetAlert };
});
vi.mock('@/lib/agents/cron-lease', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agents/cron-lease')>('@/lib/agents/cron-lease');
  return { ...actual, claimCronWindow };
});

import { GET } from '@/app/api/cron/llm-budget-check/route';
import { budgetAlertText } from '@/lib/telegram/admin-notify';
import { STOP_SPEND_SQL, RUNNER_SPEND_SQL } from '@/lib/ai/spend-scope';

const envBefore = { ...process.env };
const call = () => GET(new Request('https://vedarai.ru/api/cron/llm-budget-check', {
  headers: { authorization: 'Bearer cron-test' },
}));

interface Body { ok: boolean; status: string; spent_usd?: number; runner_spent_usd?: number; limit_usd?: number }

beforeEach(() => {
  poolQuery.mockReset();
  recordCronRun.mockReset();
  notifyBudgetAlert.mockClear();
  claimCronWindow.mockResolvedValue('claimed');
  process.env.CRON_SECRET = 'cron-test';
  process.env.AI_DAILY_BUDGET_USD = '5';
  process.env.LLM_BUDGET_KERNEL = 'off';
  kernelBudget.recordBudgetStop.mockClear();
  kernelBudget.ensureBudgetAlert.mockClear();
});

afterEach(() => {
  process.env = { ...envBefore };
});

describe('крон тревоги сверяет с порогом расход сайта', () => {
  it('день 23.11: сайт $0,58, раннер $7,02 — тревоги нет, раннер назван', async () => {
    poolQuery.mockResolvedValue({ rows: [{ spent: '0.58', runner_spent: '7.02', unknown_calls: '0' }] });
    const body = await (await call()).json() as Body;
    expect(body).toMatchObject({ ok: true, status: 'ok', spent_usd: 0.58, runner_spent_usd: 7.02, limit_usd: 5 });
    expect(notifyBudgetAlert).not.toHaveBeenCalled();
  });

  it('сайт достиг порога — тревога уходит, и в ней расход раннера', async () => {
    poolQuery.mockResolvedValue({ rows: [{ spent: '5.40', runner_spent: '2.10', unknown_calls: '0' }] });
    const body = await (await call()).json() as Body;
    expect(body.status).toBe('alert_sent');
    expect(notifyBudgetAlert).toHaveBeenCalledWith(5.4, 5, 2.1);
  });

  it('запрос делит сумму одним правилом со стопом', async () => {
    poolQuery.mockResolvedValue({ rows: [{ spent: '0', runner_spent: '0', unknown_calls: '0' }] });
    await call();
    const sql = String(poolQuery.mock.calls[0]?.[0] ?? '');
    expect(sql).toContain(`FILTER (WHERE ${STOP_SPEND_SQL})`);
    expect(sql).toContain(`FILTER (WHERE ${RUNNER_SPEND_SQL})`);
  });
});

describe('закрытие стопа — факт в ядре, алерт один раз за сутки (PR 1a серии «ядро»)', () => {
  beforeEach(() => {
    delete process.env.LLM_BUDGET_KERNEL;
    poolQuery.mockResolvedValue({ rows: [{ spent: '5.40', runner_spent: '2.10', unknown_calls: '0' }] });
  });

  it('крон пишет стоп в ядро и шлёт через журнал: доставлено — alert_sent', async () => {
    const body = await (await call()).json() as Body;
    expect(body.status).toBe('alert_sent');
    expect(kernelBudget.recordBudgetStop).toHaveBeenCalledWith({ limitUsd: 5, trigger: 'cron' });
    expect(kernelBudget.ensureBudgetAlert).toHaveBeenCalledWith({
      taskId: 'task-day', spentUsd: 5.4, limitUsd: 5, runnerSpentUsd: 2.1, mode: 'cron',
    });
    expect(notifyBudgetAlert).not.toHaveBeenCalled();
  });

  it('повтор за те же сутки — alert_already_sent_today, ok: true', async () => {
    kernelBudget.ensureBudgetAlert.mockResolvedValueOnce({ status: 'already_sent' });
    const body = await (await call()).json() as Body & { alert: unknown };
    expect(body).toMatchObject({ ok: true, status: 'alert_already_sent_today', spent_usd: 5.4, limit_usd: 5 });
    expect(body.alert).toEqual({ ok: true, status: 'already_sent' });
  });

  it('недоставка — alert_not_delivered, в поле alert прежнее ok: false и причина', async () => {
    kernelBudget.ensureBudgetAlert.mockResolvedValueOnce({ status: 'not_delivered', reason: 'chat not found' });
    const body = await (await call()).json() as Body & { alert: unknown };
    expect(body.status).toBe('alert_not_delivered');
    expect(body.alert).toEqual({ ok: false, status: 'not_delivered', reason: 'chat not found' });
  });

  it('LLM_BUDGET_KERNEL=off — прежнее поведение: алерт каждым прогоном, ядро не трогается', async () => {
    process.env.LLM_BUDGET_KERNEL = 'off';
    await call();
    await call();
    expect(notifyBudgetAlert.mock.calls).toEqual([[5.4, 5, 2.1], [5.4, 5, 2.1]]);
    expect(kernelBudget.recordBudgetStop).not.toHaveBeenCalled();
    expect(kernelBudget.ensureBudgetAlert).not.toHaveBeenCalled();
  });
});

describe('текст тревоги', () => {
  it('называет расход сайта, лимит и раннер отдельной строкой', () => {
    const text = budgetAlertText(5.4, 5, 7.02);
    expect(text).toContain('Потрачено сайтом:</b> $5.4000');
    expect(text).toContain('Раннер GitHub (в лимит не входит):</b> $7.0200');
    expect(text).toContain('Кузьмич отвечает туристам, что на сегодня отдыхает');
  });

  it('сумма раннера не передана — строки о нём нет, нулём она не становится', () => {
    expect(budgetAlertText(5.4, 5)).not.toMatch(/Раннер GitHub/);
    expect(budgetAlertText(5.4, 5, 0)).toContain('Раннер GitHub (в лимит не входит):</b> $0.0000');
  });
});
