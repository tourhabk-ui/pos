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
