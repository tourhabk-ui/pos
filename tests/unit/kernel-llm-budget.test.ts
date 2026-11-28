/**
 * Ядро видит закрытие суточного стопа LLM и один раз за сутки говорит
 * владельцу (PR 1a серии «ядро», задание 29.11).
 *
 * Без реальных вызовов моделей, БД и Telegram: подменены пул, ядро
 * (createTask / claimTaskById / appendEvent / transition), отправка алерта
 * (с настоящим текстом) и чтение суммы с ключом суток. Часы троттлинга
 * двигаются только vi.setSystemTime — у кэша стопа 15 с свои часы.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  createTask: vi.fn(),
  claimTaskById: vi.fn(),
  appendEvent: vi.fn(),
  transition: vi.fn(),
  notifyBudgetAlert: vi.fn(),
  readSpendKey: vi.fn(),
}));

vi.mock('@/lib/db-pool', () => ({ pool: { query: h.poolQuery } }));
vi.mock('@/lib/agents/kernel/kernel', () => ({
  createTask: h.createTask,
  claimTaskById: h.claimTaskById,
  appendEvent: h.appendEvent,
  transition: h.transition,
}));
vi.mock('@/lib/telegram/admin-notify', async (orig) => {
  const actual = await orig<typeof import('@/lib/telegram/admin-notify')>();
  return { ...actual, notifyBudgetAlert: h.notifyBudgetAlert };
});
vi.mock('@/lib/ai/anon-chat-guard', async (orig) => {
  const actual = await orig<typeof import('@/lib/ai/anon-chat-guard')>();
  return { ...actual, readLlmSpendWithDayKey: h.readSpendKey };
});

import {
  recordBudgetStop,
  ensureBudgetAlert,
  resetBudgetStopThrottleForTests,
  LLM_BUDGET_DENY_REASON,
  BUDGET_STOP_THROTTLE_MS,
} from '@/lib/agents/kernel/llm-budget';
import { configureDailySpendGateForTests, isDailyLlmBudgetStopped } from '@/lib/ai/daily-spend-gate';

const DAY = '2026-11-29';
const T0 = new Date('2026-11-29T05:00:00Z').getTime();
const TASK = { id: 'task-day-1' };
let savedGha: string | undefined;
let savedKernel: string | undefined;
let errSpy: ReturnType<typeof vi.spyOn>;

const journal = (delivered: boolean) => (sql: string) =>
  Promise.resolve({ rows: /agent_events/.test(sql) && delivered ? [{ '?column?': 1 }] : [] });

beforeEach(() => {
  savedGha = process.env.GITHUB_ACTIONS;
  savedKernel = process.env.LLM_BUDGET_KERNEL;
  delete process.env.GITHUB_ACTIONS;
  delete process.env.LLM_BUDGET_KERNEL;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  resetBudgetStopThrottleForTests();
  for (const f of Object.values(h)) f.mockReset();
  h.readSpendKey.mockResolvedValue({ spentUsd: 6.2, dayKey: DAY });
  h.createTask.mockResolvedValue({ created: true, task: TASK });
  h.claimTaskById.mockResolvedValue(TASK);
  h.appendEvent.mockResolvedValue({ ok: true });
  h.transition.mockResolvedValue({ ok: true });
  h.notifyBudgetAlert.mockResolvedValue({ ok: true });
  h.poolQuery.mockImplementation(journal(false));
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (savedGha === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = savedGha;
  if (savedKernel === undefined) delete process.env.LLM_BUDGET_KERNEL; else process.env.LLM_BUDGET_KERNEL = savedKernel;
  configureDailySpendGateForTests(null);
  errSpy.mockRestore();
  vi.useRealTimers();
});

const after = (ms: number) => vi.setSystemTime(Date.now() + ms);
const stopEvents = () => h.appendEvent.mock.calls.filter((c) => c[2] === 'policy_denied');

describe('recordBudgetStop: факт закрытия стопа — одна задача на сутки', () => {
  it('первый вызов суток: задача с ключом суток, policy_denied с суммами, succeeded', async () => {
    const r = await recordBudgetStop({ limitUsd: 5, trigger: 'gate' });
    expect(r).toEqual({ first: true, throttled: false, taskId: TASK.id, spentUsd: 6.2, dayKey: DAY });
    expect(h.createTask).toHaveBeenCalledWith(expect.objectContaining({
      principal: 'system:llm-budget',
      capability: 'llm.budget_stop',
      risk: 'safe',
      state: 'queued',
      resource: { type: 'llm_budget', id: DAY },
      idempotencyKey: `llm-budget-stop:${DAY}`,
    }));
    expect(h.claimTaskById).toHaveBeenCalledWith(TASK.id, 'system:llm-budget');
    expect(stopEvents()).toHaveLength(1);
    expect(stopEvents()[0][3]).toEqual({
      reason: LLM_BUDGET_DENY_REASON(6.2, 5), phase: 'admission', spent_usd: 6.2, limit_usd: 5, trigger: 'gate',
    });
    expect(h.transition).toHaveBeenCalledWith(TASK.id, 'running', 'succeeded', 'kernel',
      expect.objectContaining({ summary: 'стоп расходов LLM закрыт: потрачено $6.20 из $5.00' }));
  });

  it('второй за сутки (ключ занят) — first: false, taskId существующей, второго события нет', async () => {
    await recordBudgetStop({ limitUsd: 5, trigger: 'gate' });
    after(BUDGET_STOP_THROTTLE_MS);
    h.createTask.mockResolvedValue({ created: false, existing: TASK, conflict: 'idempotency' });
    const r = await recordBudgetStop({ limitUsd: 5, trigger: 'cron' });
    expect(r).toEqual({ first: false, throttled: false, taskId: TASK.id, spentUsd: 6.2, dayKey: DAY });
    expect(stopEvents()).toHaveLength(1);
  });

  it('в пределах 10 минут — из памяти процесса, сумма не читается', async () => {
    await recordBudgetStop({ limitUsd: 5, trigger: 'gate' });
    after(BUDGET_STOP_THROTTLE_MS - 1);
    const r = await recordBudgetStop({ limitUsd: 5, trigger: 'gate' });
    expect(r).toMatchObject({ first: false, throttled: true, taskId: TASK.id });
    expect(h.readSpendKey).toHaveBeenCalledTimes(1);
  });

  it('свежая сумма ниже лимита (кэш стопа отстал) — записи нет и окно троттлинга не держится', async () => {
    h.readSpendKey.mockResolvedValue({ spentUsd: 4.5, dayKey: DAY });
    expect(await recordBudgetStop({ limitUsd: 5, trigger: 'gate' })).toMatchObject({ first: false, throttled: false, taskId: null });
    expect(h.createTask).not.toHaveBeenCalled();
    await recordBudgetStop({ limitUsd: 5, trigger: 'gate' });
    expect(h.readSpendKey).toHaveBeenCalledTimes(2);
  });

  it('пустой или битый ключ суток — записи нет, не бросает, повтор только через 10 минут', async () => {
    for (const dayKey of ['', undefined, '29.11.2026']) {
      resetBudgetStopThrottleForTests();
      h.readSpendKey.mockResolvedValueOnce({ spentUsd: 6.2, dayKey });
      expect(await recordBudgetStop({ limitUsd: 5, trigger: 'gate' })).toMatchObject({ taskId: null, throttled: false });
    }
    expect(h.createTask).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
    h.readSpendKey.mockResolvedValue({ spentUsd: 6.2, dayKey: '' });
    const reads = h.readSpendKey.mock.calls.length;
    await recordBudgetStop({ limitUsd: 5, trigger: 'gate' });
    expect(h.readSpendKey).toHaveBeenCalledTimes(reads);
    after(BUDGET_STOP_THROTTLE_MS);
    h.readSpendKey.mockResolvedValue({ spentUsd: 6.2, dayKey: DAY });
    expect(await recordBudgetStop({ limitUsd: 5, trigger: 'gate' })).toMatchObject({ first: true, taskId: TASK.id });
  });

  it('ошибка БД — не бросает, в лог, повтор через 10 минут снова пишет', async () => {
    h.createTask.mockRejectedValueOnce(new Error('connection refused'));
    expect(await recordBudgetStop({ limitUsd: 5, trigger: 'gate' })).toMatchObject({ taskId: null });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('закрытие стопа не записано'), 'connection refused');
    await recordBudgetStop({ limitUsd: 5, trigger: 'gate' });
    expect(h.createTask).toHaveBeenCalledTimes(1);
    after(BUDGET_STOP_THROTTLE_MS);
    expect(await recordBudgetStop({ limitUsd: 5, trigger: 'gate' })).toMatchObject({ first: true, taskId: TASK.id });
    expect(h.createTask).toHaveBeenCalledTimes(2);
  });

  it('событие policy_denied не записалось — задача всё равно succeeded с пометкой, ключ суток занят', async () => {
    h.appendEvent.mockResolvedValueOnce({ ok: false, reason: 'deadlock' });
    expect(await recordBudgetStop({ limitUsd: 5, trigger: 'gate' })).toMatchObject({ first: true, taskId: TASK.id });
    const [, from, to, , details] = h.transition.mock.calls[0];
    expect([from, to]).toEqual(['running', 'succeeded']);
    expect(details.summary).toMatch(/событие policy_denied не записано: deadlock/);
    expect(details.event_write_error).toBe('deadlock');
  });

  it('вызов во время идущей попытки ждёт её и получает её taskId — сумма читается один раз', async () => {
    let finish!: () => void;
    h.createTask.mockImplementationOnce(() => new Promise((r) => { finish = () => r({ created: true, task: TASK }); }));
    const gate = recordBudgetStop({ limitUsd: 5, trigger: 'gate' });
    await vi.waitFor(() => expect(h.createTask).toHaveBeenCalledTimes(1));
    const cron = recordBudgetStop({ limitUsd: 5, trigger: 'cron' });
    finish();
    expect(await gate).toMatchObject({ first: true, taskId: TASK.id });
    // Крону нужен taskId: без него он послал бы алерт мимо журнала.
    expect(await cron).toMatchObject({ first: false, throttled: true, taskId: TASK.id });
    expect(h.readSpendKey).toHaveBeenCalledTimes(1);
    expect(h.createTask).toHaveBeenCalledTimes(1);
  });

  it('захват задачи не удался (null или ошибка) — не бросает, в лог; ключ суток занят задачей в queued', async () => {
    for (const fail of [() => h.claimTaskById.mockResolvedValueOnce(null), () => h.claimTaskById.mockRejectedValueOnce(new Error('lock timeout'))]) {
      resetBudgetStopThrottleForTests();
      h.transition.mockClear();
      h.appendEvent.mockClear();
      fail();
      expect(await recordBudgetStop({ limitUsd: 5, trigger: 'gate' })).toMatchObject({ first: true, taskId: TASK.id });
      expect(h.transition).not.toHaveBeenCalled();
      expect(stopEvents()).toHaveLength(0);
    }
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('осталась в queued'));
  });

  it('LLM_BUDGET_KERNEL=off — ничего не читается и не пишется', async () => {
    process.env.LLM_BUDGET_KERNEL = ' OFF ';
    expect(await recordBudgetStop({ limitUsd: 5, trigger: 'gate' })).toEqual({ first: false, throttled: false, taskId: null, spentUsd: null, dayKey: null });
    expect(h.readSpendKey).not.toHaveBeenCalled();
    expect(h.createTask).not.toHaveBeenCalled();
  });
});

describe('ensureBudgetAlert: один алерт за сутки по журналу задачи', () => {
  const base = { taskId: TASK.id, spentUsd: 5.4, limitUsd: 5, runnerSpentUsd: 2.1 };

  it('доставки ещё не было — одна отправка и note {alert: delivered}', async () => {
    expect(await ensureBudgetAlert({ ...base, mode: 'cron' })).toEqual({ status: 'sent' });
    expect(h.notifyBudgetAlert).toHaveBeenCalledWith(5.4, 5, 2.1);
    expect(h.appendEvent).toHaveBeenCalledWith(TASK.id, 'kernel', 'note', { alert: 'delivered' });
  });

  it('доставка уже была — already_sent, отправки нет', async () => {
    h.poolQuery.mockImplementation(journal(true));
    expect(await ensureBudgetAlert({ ...base, mode: 'cron' })).toEqual({ status: 'already_sent' });
    expect(h.notifyBudgetAlert).not.toHaveBeenCalled();
  });

  it('недоставка — note {alert: not_delivered}, следующий вызов шлёт снова', async () => {
    h.notifyBudgetAlert.mockResolvedValueOnce({ ok: false, reason: 'chat not found' });
    expect(await ensureBudgetAlert({ ...base, mode: 'cron' })).toEqual({ status: 'not_delivered', reason: 'chat not found' });
    expect(h.appendEvent).toHaveBeenCalledWith(TASK.id, 'kernel', 'note', { alert: 'not_delivered', reason: 'chat not found' });
    expect(await ensureBudgetAlert({ ...base, mode: 'cron' })).toEqual({ status: 'sent' });
    expect(h.notifyBudgetAlert).toHaveBeenCalledTimes(2);
  });

  it('крон без задачи суток или с непрочитанным журналом — прямая отправка, как на main', async () => {
    expect(await ensureBudgetAlert({ ...base, taskId: null, mode: 'cron' })).toEqual({ status: 'sent' });
    h.poolQuery.mockRejectedValue(new Error('pool exhausted'));
    expect(await ensureBudgetAlert({ ...base, mode: 'cron' })).toEqual({ status: 'sent' });
    expect(h.notifyBudgetAlert.mock.calls).toEqual([[5.4, 5, 2.1], [5.4, 5, 2.1]]);
  });

  it('путь стопа без задачи или с непрочитанным журналом — skipped, не шлёт', async () => {
    expect(await ensureBudgetAlert({ ...base, taskId: null, mode: 'gate' })).toEqual({ status: 'skipped' });
    h.poolQuery.mockRejectedValue(new Error('pool exhausted'));
    expect((await ensureBudgetAlert({ ...base, mode: 'gate' })).status).toBe('skipped');
    expect(h.notifyBudgetAlert).not.toHaveBeenCalled();
  });

  it('одновременные вызовы для одной задачи (путь стопа и крон) — одна отправка', async () => {
    let open!: () => void;
    h.poolQuery.mockImplementationOnce(() => new Promise((r) => { open = () => r({ rows: [] }); }));
    const gate = ensureBudgetAlert({ ...base, runnerSpentUsd: null, mode: 'gate' });
    const cron = ensureBudgetAlert({ ...base, mode: 'cron' });
    open();
    expect(await gate).toEqual({ status: 'sent' });
    expect(await cron).toEqual({ status: 'sent' });
    expect(h.notifyBudgetAlert).toHaveBeenCalledTimes(1);
    expect(h.poolQuery).toHaveBeenCalledTimes(1);
  });

  it('крон ждал путь стопа, а у того журнал не прочитался — крон шлёт сам', async () => {
    let fail!: (e: Error) => void;
    h.poolQuery.mockImplementationOnce(() => new Promise((_, rej) => { fail = rej; }));
    const gate = ensureBudgetAlert({ ...base, runnerSpentUsd: null, mode: 'gate' });
    const cron = ensureBudgetAlert({ ...base, mode: 'cron' });
    fail(new Error('timeout'));
    expect((await gate).status).toBe('skipped');
    expect(await cron).toEqual({ status: 'sent' });
    expect(h.notifyBudgetAlert.mock.calls).toEqual([[5.4, 5, 2.1]]);
  });

  it('LLM_BUDGET_KERNEL=off — disabled', async () => {
    process.env.LLM_BUDGET_KERNEL = 'off';
    expect(await ensureBudgetAlert({ ...base, mode: 'cron' })).toEqual({ status: 'disabled' });
    expect(h.notifyBudgetAlert).not.toHaveBeenCalled();
  });
});

describe('путь стопа (isDailyLlmBudgetStopped): запись не ждётся, один алерт на процесс', () => {
  beforeEach(() => {
    configureDailySpendGateForTests({ readSpendToday: async () => 6.2, budgetUsd: () => 5 });
  });
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it('десять параллельных проверок при закрытом стопе — одно чтение, одна задача, один алерт', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => isDailyLlmBudgetStopped()));
    expect(results.every(Boolean)).toBe(true);
    await vi.waitFor(() => expect(h.notifyBudgetAlert).toHaveBeenCalledTimes(1));
    await settle();
    expect(h.readSpendKey).toHaveBeenCalledTimes(1);
    expect(h.createTask).toHaveBeenCalledTimes(1);
    expect(h.notifyBudgetAlert).toHaveBeenCalledTimes(1);
    expect(h.notifyBudgetAlert).toHaveBeenCalledWith(6.2, 5, null);
  });

  it('недоставленный алерт повторяется с пути стопа — после окна троттлинга, и при задаче суток', async () => {
    h.notifyBudgetAlert.mockResolvedValueOnce({ ok: false, reason: 'telegram down' });
    await isDailyLlmBudgetStopped();
    await vi.waitFor(() => expect(h.notifyBudgetAlert).toHaveBeenCalledTimes(1));
    await settle();
    await isDailyLlmBudgetStopped();
    await settle();
    expect(h.notifyBudgetAlert).toHaveBeenCalledTimes(1);
    after(BUDGET_STOP_THROTTLE_MS);
    h.createTask.mockResolvedValue({ created: false, existing: TASK, conflict: 'idempotency' });
    await isDailyLlmBudgetStopped();
    await vi.waitFor(() => expect(h.notifyBudgetAlert).toHaveBeenCalledTimes(2));
  });

  it('стоп открыт — в ядро ничего не идёт', async () => {
    configureDailySpendGateForTests({ readSpendToday: async () => 4.99, budgetUsd: () => 5 });
    expect(await isDailyLlmBudgetStopped()).toBe(false);
    await settle();
    expect(h.readSpendKey).not.toHaveBeenCalled();
  });
});

describe('слои и единое место разбора выключателя', () => {
  const ROOT = process.cwd();
  function files(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = join(dir, name);
      const st = statSync(join(ROOT, rel));
      if (st.isDirectory()) { if (name !== 'node_modules') out.push(...files(rel)); }
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) out.push(rel);
    }
    return out;
  }

  it('process.env.LLM_BUDGET_KERNEL читается только в lib/ai/daily-budget.ts (lib, app, scripts)', () => {
    const readers = ['lib', 'app', 'scripts'].flatMap(files)
      .filter((f) => readFileSync(join(ROOT, f), 'utf8').includes('process.env.LLM_BUDGET_KERNEL'));
    expect(readers).toEqual(['lib/ai/daily-budget.ts']);
  });

  it('lib/ai не импортирует ядро статически — только import(...)', () => {
    const offenders = files('lib/ai').filter((f) =>
      /import\s[^;]*?from\s+['"]@\/lib\/agents\/kernel/.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
