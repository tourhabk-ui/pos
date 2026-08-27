/**
 * Agent Kernel v1 — сторож ядра (миграция 917 + lib/agents/kernel).
 *
 * Держит инварианты, ради которых ядро заводилось:
 *  - жизненный цикл — только по матрице, терминалы не оживают;
 *  - agent_events append-only: и в коде (ни одного UPDATE/DELETE по
 *    журналу во всём репо), и в БД (триггер в миграции), seq уникален;
 *  - захват атомарен и фиксирует lease ДО эффекта;
 *  - DB-транзакций вокруг эффекта нет;
 *  - policy fail-closed: незнакомая capability — ask, запрещённая — deny;
 *  - идемпотентность: повтор ключа — duplicate без эффекта, тот же ключ с
 *    другим входом — конфликт, не старый результат.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALLOWED_TRANSITIONS,
  TASK_STATES,
  TERMINAL_STATES,
  isTransitionAllowed,
} from '@/lib/agents/kernel/types';
import { decideCapability, CAPABILITY_REGISTRY } from '@/lib/agents/kernel/policy';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('матрица жизненного цикла', () => {
  it('терминальные состояния не имеют исходящих переходов', () => {
    for (const s of TERMINAL_STATES) {
      expect(ALLOWED_TRANSITIONS[s], `терминал ${s} ожил`).toBeUndefined();
    }
  });

  it('все переходы ведут в объявленные состояния', () => {
    for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
      expect(TASK_STATES).toContain(from);
      for (const to of targets) expect(TASK_STATES).toContain(to);
    }
  });

  it('точечные проверки: разрешённое проходит, перескоки — нет', () => {
    expect(isTransitionAllowed('queued', 'running')).toBe(true);
    expect(isTransitionAllowed('running', 'succeeded')).toBe(true);
    expect(isTransitionAllowed('failed_retryable', 'queued')).toBe(true);
    expect(isTransitionAllowed('queued', 'succeeded')).toBe(false);
    expect(isTransitionAllowed('succeeded', 'queued')).toBe(false);
    expect(isTransitionAllowed('proposed', 'running')).toBe(false);
  });

  it('partial — не состояние задачи (решение владельца 27.08)', () => {
    expect(TASK_STATES as readonly string[]).not.toContain('partial');
  });
});

describe('миграция 917: журнал защищён на уровне БД', () => {
  const sql = read('migrations/917_agent_kernel.sql');

  it('agent_events: (task_id, seq) уникален, триггер режет UPDATE/DELETE', () => {
    expect(sql).toMatch(/UNIQUE \(task_id, seq\)/);
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON agent_events/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });

  it('идемпотентность: частичный UNIQUE по succeeded', () => {
    expect(sql).toMatch(/UNIQUE INDEX[\s\S]{0,120}idempotency_key[\s\S]{0,120}state = 'succeeded'/);
  });
});

describe('kernel: захват и append-only в коде', () => {
  const kernel = read('lib/agents/kernel/kernel.ts');
  const governed = read('lib/agents/kernel/governed-action.ts');

  it('захват — один UPDATE queued→running с SKIP LOCKED и lease', () => {
    expect(kernel).toMatch(/SET state = 'running', claimed_by[\s\S]{0,200}lease_until = NOW\(\)/);
    expect(kernel).toMatch(/FOR UPDATE SKIP LOCKED/);
  });

  it('в репозитории нет UPDATE/DELETE по agent_events', () => {
    // Судим по коду ядра и по всему живому коду: журнал правится только строкой.
    const offenders: string[] = [];
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execSync(
      `grep -rlE "(UPDATE\\s+agent_events|DELETE\\s+FROM\\s+agent_events)" lib app scripts migrations --include='*.ts' --include='*.js' --include='*.sql' || true`,
      { cwd: process.cwd(), encoding: 'utf-8' },
    );
    for (const f of out.split('\n').filter(Boolean)) {
      // Триггеру в 917 позволено УПОМИНАТЬ операции — он их запрещает.
      if (f.includes('917_agent_kernel.sql')) continue;
      offenders.push(f);
    }
    expect(offenders, `журнал кто-то правит: ${offenders.join(', ')}`).toEqual([]);
  });

  it('эффект исполняется вне DB-транзакций ядра', () => {
    // В governed-action нет BEGIN/COMMIT вовсе: транзакции живут только в
    // kernel.ts вокруг записей состояния, никогда вокруг execute().
    expect(governed).not.toMatch(/BEGIN|COMMIT/);
  });
});

describe('три контура подключены к ядру', () => {
  it('операторские write-tools идут через executeGovernedAction', () => {
    const src = read('lib/agents/sdk/operator-tools.ts');
    expect(src).toMatch(/from '@\/lib\/agents\/kernel'/);
    // Обе мутации — под ядром; прямых UPDATE вне execute() не осталось.
    expect(src).toMatch(/capability: 'tour\.set_published'/);
    expect(src).toMatch(/capability: 'tour\.update_price'/);
  });

  it('approval executor исполняет через ядро с ключом по approval_id', () => {
    const src = read('lib/agents/execution/initiative-executor.ts');
    expect(src).toMatch(/capability: 'initiative\.execute'/);
    expect(src).toMatch(/idempotencyKey: `initiative:\$\{task\.approval_id\}`/);
  });

  it('прогон Evo — kernel-задача со стадиями, отказ ядра виден в ответе', () => {
    const adapter = read('lib/agents/kernel/adapters/evo-run-task.ts');
    expect(adapter).toMatch(/capability: 'evo\.run'/);
    const route = read('app/api/cron/evo/route.ts');
    expect(route).toMatch(/startEvoRunTask/);
    expect(route).toMatch(/kernel_task_id: kernelHandle\?\.taskId \?\? null/);
  });

  it('каждая подключённая capability объявлена в реестре policy', () => {
    for (const cap of ['tour.set_published', 'tour.update_price', 'initiative.execute', 'evo.run']) {
      expect(decideCapability(cap).decision, `${cap} не в реестре — ушла бы в ask`).toBe('allow');
    }
  });
});

describe('policy: fail-closed', () => {
  it('незнакомая capability — ask, запрещённая — deny', () => {
    expect(decideCapability('something.new').decision).toBe('ask');
    expect(decideCapability('payment.execute').decision).toBe('deny');
  });

  it('каждая запись реестра несёт причину категории', () => {
    for (const [cap, entry] of Object.entries(CAPABILITY_REGISTRY)) {
      expect(entry.reason.length, `${cap} без причины`).toBeGreaterThan(10);
    }
  });
});

// ── Поведение executeGovernedAction (kernel и approvals замоканы) ──────────

const { kernelMock, approvalMock } = vi.hoisted(() => ({
  kernelMock: {
    createTask: vi.fn(),
    transition: vi.fn(),
    claimTask: vi.fn(),
    appendEvent: vi.fn(),
    findByIdempotencyKey: vi.fn(),
  },
  approvalMock: { request: vi.fn() },
}));

vi.mock('@/lib/agents/kernel/kernel', () => kernelMock);
vi.mock('@/lib/agents/safeguards/approval-required', () => ({ approvalRequired: approvalMock }));

const baseTask = {
  id: 't1', parent_task_id: null, trace_id: 'tr1', principal: 'p', capability: 'tour.set_published',
  resource_type: null, resource_id: null, risk: 'safe' as const, state: 'queued' as const,
  idempotency_key: null, input_hash: null, attempt: 0, summary: null,
};

describe('executeGovernedAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kernelMock.appendEvent.mockResolvedValue({ ok: true });
    kernelMock.transition.mockResolvedValue({ ok: true });
    kernelMock.findByIdempotencyKey.mockResolvedValue(null);
  });

  it('успех: policy → создание → захват → эффект → succeeded', async () => {
    kernelMock.createTask.mockResolvedValueOnce({ ...baseTask });
    kernelMock.claimTask.mockResolvedValueOnce({ ...baseTask, state: 'running' });
    const { executeGovernedAction } = await import('@/lib/agents/kernel/governed-action');

    const res = await executeGovernedAction({
      principal: 'operator:1',
      capability: 'tour.set_published',
      execute: async () => 'done',
    });

    expect(res.ok).toBe(true);
    expect(kernelMock.claimTask).toHaveBeenCalled();
    expect(kernelMock.transition).toHaveBeenCalledWith('t1', 'running', 'succeeded', 'operator:1', expect.anything());
    // Эффект обёрнут событиями started/committed.
    const types = kernelMock.appendEvent.mock.calls.map((c) => c[2]);
    expect(types).toContain('effect_started');
    expect(types).toContain('effect_committed');
  });

  it('провал эффекта → failed_terminal, ошибка не глотается', async () => {
    kernelMock.createTask.mockResolvedValueOnce({ ...baseTask });
    kernelMock.claimTask.mockResolvedValueOnce({ ...baseTask, state: 'running' });
    const { executeGovernedAction } = await import('@/lib/agents/kernel/governed-action');

    const res = await executeGovernedAction({
      principal: 'operator:1',
      capability: 'tour.set_published',
      execute: async () => { throw new Error('boom'); },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('boom');
    expect(kernelMock.transition).toHaveBeenCalledWith('t1', 'running', 'failed_terminal', 'operator:1', expect.anything());
  });

  it('повтор ключа после успеха → duplicate, эффект не исполняется', async () => {
    kernelMock.findByIdempotencyKey.mockResolvedValueOnce({
      ...baseTask, state: 'succeeded', idempotency_key: 'k1', input_hash: 'h1',
    });
    const { executeGovernedAction } = await import('@/lib/agents/kernel/governed-action');
    const execute = vi.fn();

    const res = await executeGovernedAction({
      principal: 'operator:1',
      capability: 'tour.set_published',
      idempotencyKey: 'k1',
      inputHash: 'h1',
      execute,
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.duplicate).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(kernelMock.createTask).not.toHaveBeenCalled();
  });

  it('тот же ключ с другим входом → конфликт, не старый результат', async () => {
    kernelMock.findByIdempotencyKey.mockResolvedValueOnce({
      ...baseTask, state: 'succeeded', idempotency_key: 'k1', input_hash: 'h1',
    });
    const { executeGovernedAction } = await import('@/lib/agents/kernel/governed-action');
    const execute = vi.fn();

    const res = await executeGovernedAction({
      principal: 'operator:1',
      capability: 'tour.set_published',
      idempotencyKey: 'k1',
      inputHash: 'h2-другой-вход',
      execute,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('конфликт идемпотентности');
    expect(execute).not.toHaveBeenCalled();
  });

  it('незнакомая capability → awaiting_approval через адаптер ApprovalRequired', async () => {
    approvalMock.request.mockResolvedValueOnce({ needs_approval: true, id: 'appr-1' });
    kernelMock.createTask.mockResolvedValueOnce({ ...baseTask, state: 'awaiting_approval' });
    const { executeGovernedAction } = await import('@/lib/agents/kernel/governed-action');
    const execute = vi.fn();

    const res = await executeGovernedAction({
      principal: 'agent:x',
      capability: 'unknown.capability',
      execute,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.state).toBe('awaiting_approval');
    expect(approvalMock.request).toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('запрещённая capability → rejected + policy_denied, эффект не исполняется', async () => {
    kernelMock.createTask.mockResolvedValueOnce({ ...baseTask, state: 'rejected' });
    const { executeGovernedAction } = await import('@/lib/agents/kernel/governed-action');
    const execute = vi.fn();

    const res = await executeGovernedAction({
      principal: 'agent:x',
      capability: 'payment.execute',
      execute,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.state).toBe('rejected');
    expect(execute).not.toHaveBeenCalled();
    const types = kernelMock.appendEvent.mock.calls.map((c) => c[2]);
    expect(types).toContain('policy_denied');
  });
});
