/**
 * Agent Kernel v1 — сторож ядра (миграция 917 + lib/agents/kernel).
 *
 * Держит инварианты, ради которых ядро заводилось:
 *  - жизненный цикл — только по матрице, терминалы не оживают;
 *  - agent_events append-only: и в коде (ни одного UPDATE/DELETE по
 *    журналу во всём репо), и в БД (триггер в миграции), seq уникален;
 *  - захват атомарен и фиксирует lease ДО эффекта;
 *  - DB-транзакций вокруг эффекта нет;
 *  - policy fail-closed: незнакомое и запрещённое — deny, очереди к человеку нет;
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
import { decidePolicy, CAPABILITY_REGISTRY, FORBIDDEN_CAPABILITIES } from '@/lib/agents/kernel/policy';

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

  it('918: у ключа идемпотентности один АКТИВНЫЙ владелец, awaiting_merge в CHECK', () => {
    const m918 = read('migrations/918_kernel_autonomy.sql');
    expect(m918).toMatch(/idx_agent_tasks_idempotency_active/);
    expect(m918).toMatch(/'queued','running','awaiting_merge','succeeded'/);
    expect(m918).toMatch(/DROP INDEX IF EXISTS idx_agent_tasks_idempotency_succeeded/);
    expect(m918).toMatch(/awaiting_merge/);
  });

  it('awaiting_merge — только у контура кода: операционные адаптеры его не используют', () => {
    for (const f of [
      'lib/agents/kernel/governed-action.ts',
      'lib/agents/kernel/adapters/initiative-tasks.ts',
      'lib/agents/kernel/adapters/evo-run-task.ts',
      'lib/agents/sdk/operator-tools.ts',
    ]) {
      expect(read(f), `${f} трогает awaiting_merge — это состояние только для code/policy задач (PR B)`)
        .not.toContain('awaiting_merge');
    }
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

  it('op_add_slots (operator-agency.ts) — тоже через ядро, не инлайн-SQL (P2, 28.08)', () => {
    const src = read('lib/agents/agencies/operator-agency.ts');
    // Динамический import — тот же, что уже использует createTour в этом файле.
    expect(src).toMatch(/await import\('@\/lib\/agents\/kernel'\)/);
    expect(src).toMatch(/capability: 'tour\.add_slots'/);
    // Владение туром теперь проверяет policy, не собственный SELECT.
    expect(src).not.toMatch(/SELECT id FROM operator_tours WHERE id = \$1 AND operator_id = \$2/);
    // resource передан — иначе operatorOwnsTour не найдёт, что проверять.
    expect(src).toMatch(/resource: \{ type: 'tour', id: String\(tourId\) \}/);
  });

  it('agent_effects (P3, 922): governed-action и инициативы заводят durable intent ДО эффекта', () => {
    const gov = read('lib/agents/kernel/governed-action.ts');
    expect(gov).toMatch(/beginEffect\(claimed\.id, claimed\.id/);
    // beginEffect ДО input.execute() — иначе intent появится уже после эффекта.
    expect(gov.indexOf('beginEffect(claimed.id')).toBeLessThan(gov.indexOf('await input.execute()'));
    expect(gov).toMatch(/commitEffect\(beginResult\.effect\.id/);
    expect(gov).toMatch(/failEffect\(beginResult\.effect\.id/);

    const adapter = read('lib/agents/kernel/adapters/initiative-tasks.ts');
    expect(adapter).toMatch(/beginEffect\(task\.id, task\.id/);
    expect(adapter).toMatch(/commitEffect\(beginResult\.effect\.id/);
    expect(adapter).toMatch(/failEffect\(beginResult\.effect\.id/);
  });

  it('кокпит показывает зависшие эффекты (P3), не только состояния задач', () => {
    const route = read('app/api/admin/volcano/route.ts');
    expect(route).toMatch(/findStuckEffects/);
    expect(route).toMatch(/stuck_effects/);
    const client = read('app/hub/admin/volcano/_VolcanoClient.tsx');
    expect(client).toMatch(/Зависших эффектов/);
    expect(client).toMatch(/data\.stuck_effects/);
  });

  it('code-change-executor: перед созданием PR ищет уже открытый по ветке, fail-open при сбое проверки', () => {
    const src = read('lib/agents/execution/handlers/code-change-executor.ts');
    expect(src).toMatch(/function findOpenPrByBranch/);
    // Обе ветки (code-change и new-page) зовут проверку до создания git-ref.
    const bodyBeforeGuard = src.split('async function findOpenPrByBranch')[0];
    expect((src.match(/findOpenPrByBranch\(branchName\)/g) ?? []).length).toBe(2);
    expect(bodyBeforeGuard).not.toMatch(/findOpenPrByBranch\(branchName\)/);
    // Ошибка самой проверки — не блокирует создание PR (лог + null, не throw наружу).
    const guardBody = src.slice(
      src.indexOf('async function findOpenPrByBranch'),
      src.indexOf('\nasync function ', src.indexOf('async function findOpenPrByBranch') + 1),
    );
    expect(guardBody).toMatch(/catch \(err\)/);
    expect(guardBody).toMatch(/return null;/);
  });

  it('инициативы: enqueue идемпотентен по approval_id, generic initiative.execute удалён', () => {
    const adapter = read('lib/agents/kernel/adapters/initiative-tasks.ts');
    expect(adapter).toMatch(/idempotencyKey: `initiative:\$\{approval\.id\}`/);
    expect(adapter).toMatch(/initiative\.\$\{actionType\}/);
    const policy = read('lib/agents/kernel/policy.ts');
    expect(policy, 'generic-safe initiative.execute вернулся — за одним именем разные классы риска')
      .not.toMatch(/'initiative\.execute'/);
    const route = read('app/api/admin/execute-all/route.ts');
    expect(route).toMatch(/sweepApprovedInitiatives/);
    expect(route, 'execute-all снова исполняет inline — модель автономии требует worker')
      .not.toMatch(/executeInitiative[^E]/);
  });

  it('прогон Evo — kernel-задача со стадиями, отказ ядра виден в ответе', () => {
    const adapter = read('lib/agents/kernel/adapters/evo-run-task.ts');
    expect(adapter).toMatch(/capability: 'evo\.run'/);
    const route = read('app/api/cron/evo/route.ts');
    expect(route).toMatch(/startEvoRunTask/);
    expect(route).toMatch(/kernel_task_id: kernelHandle\?\.taskId \?\? null/);
  });

  /**
   * Concurrency-guard (ревью 28.08): /api/cron/evo до этой правки не был
   * защищён от параллельного прогона ничем, кроме GitHub Actions
   * `concurrency: cron-evo` — а это сериализует только запуски друг с другом
   * внутри GH Actions, не запрос откуда-то ещё (внешний cron-job.org, ручной
   * dispatch, запоздавший нативный прогон). Первая версия (check-then-act по
   * kernel-задаче) заменена на `pg_try_advisory_lock` — та же техника, что
   * уже закрывает гонку овербукинга в app/api/accommodations/[id]/book
   * (см. README): проверка и захват — одна атомарная операция Postgres, а
   * не два отдельных запроса с окном гонки между ними.
   */
  it('evo: concurrency-guard — pg_try_advisory_lock атомарно, ДО kernel-задачи', () => {
    const route = read('app/api/cron/evo/route.ts');
    expect(route).toMatch(/pg_try_advisory_lock/);
    expect(route).toMatch(/pg_advisory_unlock/);
    // Порядок важен: лок захватывается ДО startEvoRunTask — проигравший не
    // заводит задачу, которую тут же пришлось бы отбрасывать.
    const lockAt = route.indexOf('tryAcquireEvoRunLock()');
    const startAt = route.indexOf('startEvoRunTask(scanType)');
    expect(lockAt).toBeGreaterThan(0);
    expect(lockAt).toBeLessThan(startAt);
    expect(route).toMatch(/status: 'skipped_already_running'/);
    // Освобождение — в finally, независимо от исхода прогона.
    expect(route).toMatch(/\} finally \{\s*\n\s*await releaseEvoRunLock\(lock\);/);
  });

  it('evo.run по-прежнему БЕЗ idempotency-ключа — каждый плановый прогон законно новый, а не retry старого', () => {
    const adapter = read('lib/agents/kernel/adapters/evo-run-task.ts');
    expect(adapter).not.toMatch(/idempotencyKey:/);
    // Guard теперь не его забота — kernel остаётся наблюдателем прогона, а
    // не местом для мьютекса поверх него.
    expect(adapter).not.toMatch(/findActiveByCapability/);
  });

  it('cron-evo.yml: skip — это не отказ, exit 0 без покраски прогона', () => {
    const wf = read('.github/workflows/cron-evo.yml');
    expect(wf).toMatch(/status == "skipped_already_running"/);
    const skipAt = wf.indexOf('skipped_already_running');
    const exitAt = wf.indexOf('exit 0', skipAt);
    expect(exitAt).toBeGreaterThan(skipAt);
  });

  it('каждая подключённая capability объявлена в реестре policy', async () => {
    const cases: Array<[string, 'operator' | 'cron' | 'admin']> = [
      ['tour.set_published', 'operator'],
      ['tour.update_price', 'operator'],
      ['tour.create_draft', 'operator'],
      ['tour.add_slots', 'operator'],
      ['evo.run', 'cron'],
      ['initiative.send_notification', 'cron'],
      ['initiative.tour_suspend', 'admin'],
    ];
    for (const [cap, ptype] of cases) {
      const v = await decidePolicy({ principal: { type: ptype, id: '1' }, capability: cap, phase: 'admission' });
      expect(v.decision, `${cap} не в реестре — была бы отклонена`).toBe('allow');
    }
  });
});

describe('policy: fail-closed, без очереди к человеку (модель автономии 27.08)', () => {
  it('незнакомая и запрещённая capability — deny, НЕ ask', async () => {
    const unknown = await decidePolicy({ principal: { type: 'cron', id: 'x' }, capability: 'something.new', phase: 'admission' });
    expect(unknown.decision).toBe('deny');
    expect(unknown.reason).toContain('не в реестре');
    const forbidden = await decidePolicy({ principal: { type: 'admin', id: 'x' }, capability: 'payment.execute', phase: 'admission' });
    expect(forbidden.decision).toBe('deny');
  });

  it('чужой тип principal — deny', async () => {
    const v = await decidePolicy({ principal: { type: 'cron', id: 'x' }, capability: 'tour.set_published', phase: 'admission' });
    expect(v.decision).toBe('deny');
    expect(v.reason).toContain('не вправе');
  });

  it('опасные инициативы запрещены поимённо, с причинами', () => {
    for (const cap of ['initiative.archive_sos', 'initiative.security_block', 'initiative.flag_payment',
                       'initiative.commission_change', 'initiative.sql_query_fix']) {
      expect(FORBIDDEN_CAPABILITIES[cap], `${cap} обязан быть в запрещённых с причиной`).toBeTruthy();
    }
  });

  it('каждая запись реестра несёт причину и типы principal', () => {
    for (const [cap, entry] of Object.entries(CAPABILITY_REGISTRY)) {
      expect(entry.reason.length, `${cap} без причины`).toBeGreaterThan(10);
      expect(entry.principalTypes.length, `${cap} без типов principal`).toBeGreaterThan(0);
    }
  });

  it('операционный gateway не знает ApprovalRequired', () => {
    // Судим по коду, не по прозе: шапка файла вправе НАЗЫВАТЬ снятую
    // зависимость, объясняя, почему её нет.
    const governed = read('lib/agents/kernel/governed-action.ts')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(governed).not.toMatch(/ApprovalRequired|approval-required/i);
    expect(governed).not.toMatch(/awaiting_approval/);
  });
});

// ── Поведение executeGovernedAction (kernel замокан; policy настоящая) ─────

const { kernelMock, effectsMock } = vi.hoisted(() => ({
  kernelMock: {
    createTask: vi.fn(),
    transition: vi.fn(),
    claimTaskById: vi.fn(),
    claimNextTask: vi.fn(),
    appendEvent: vi.fn(),
    findByIdempotencyKey: vi.fn(),
    findActiveByIdempotencyKey: vi.fn(),
  },
  effectsMock: {
    beginEffect: vi.fn(),
    commitEffect: vi.fn(),
    failEffect: vi.fn(),
  },
}));

vi.mock('@/lib/agents/kernel/kernel', () => kernelMock);
vi.mock('@/lib/agents/kernel/effects', () => effectsMock);

const baseTask = {
  id: 't1', parent_task_id: null, trace_id: 'tr1', principal: 'cron:x', capability: 'evo.run',
  resource_type: null, resource_id: null, risk: 'safe' as const, state: 'queued' as const,
  idempotency_key: null, input_hash: null, attempt: 0, summary: null,
};
const cronPrincipal = { type: 'cron', id: 'x' } as const;

describe('executeGovernedAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kernelMock.appendEvent.mockResolvedValue({ ok: true });
    kernelMock.transition.mockResolvedValue({ ok: true });
    effectsMock.beginEffect.mockResolvedValue({ outcome: 'started', effect: { id: 'ef1' } });
    effectsMock.commitEffect.mockResolvedValue({ ok: true });
    effectsMock.failEffect.mockResolvedValue({ ok: true });
  });

  it('успех: policy → создание → захват СВОЕЙ задачи по id → эффект → succeeded', async () => {
    kernelMock.createTask.mockResolvedValueOnce({ created: true, task: { ...baseTask } });
    kernelMock.claimTaskById.mockResolvedValueOnce({ ...baseTask, state: 'running' });
    const { executeGovernedAction } = await import('@/lib/agents/kernel/governed-action');

    const res = await executeGovernedAction({
      principal: cronPrincipal,
      capability: 'evo.run',
      execute: async () => 'done',
    });

    expect(res.ok).toBe(true);
    // Захват — строго по id собственной задачи, не «старейшей той же capability».
    expect(kernelMock.claimTaskById).toHaveBeenCalledWith('t1', 'cron:x');
    expect(kernelMock.claimNextTask).not.toHaveBeenCalled();
    expect(kernelMock.transition).toHaveBeenCalledWith('t1', 'running', 'succeeded', 'cron:x', expect.anything());
    const types = kernelMock.appendEvent.mock.calls.map((c) => c[2]);
    expect(types).toContain('effect_started');
    expect(types).toContain('effect_committed');
  });

  it('провал эффекта → failed_terminal, ошибка не глотается', async () => {
    kernelMock.createTask.mockResolvedValueOnce({ created: true, task: { ...baseTask } });
    kernelMock.claimTaskById.mockResolvedValueOnce({ ...baseTask, state: 'running' });
    const { executeGovernedAction } = await import('@/lib/agents/kernel/governed-action');

    const res = await executeGovernedAction({
      principal: cronPrincipal,
      capability: 'evo.run',
      execute: async () => { throw new Error('boom'); },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('boom');
    expect(kernelMock.transition).toHaveBeenCalledWith('t1', 'running', 'failed_terminal', 'cron:x', expect.anything());
  });

  it('ключ занят успешной задачей с тем же входом → duplicate, эффект не исполняется', async () => {
    kernelMock.createTask.mockResolvedValueOnce({
      created: false,
      existing: { ...baseTask, state: 'succeeded', idempotency_key: 'k1', input_hash: 'h1' },
    });
    const { executeGovernedAction } = await import('@/lib/agents/kernel/governed-action');
    const execute = vi.fn();

    const res = await executeGovernedAction({
      principal: cronPrincipal,
      capability: 'evo.run',
      idempotencyKey: 'k1',
      inputHash: 'h1',
      execute,
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.duplicate).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(kernelMock.claimTaskById).not.toHaveBeenCalled();
  });

  it('ключ занят АКТИВНОЙ задачей с тем же входом → existing/in-progress, эффект не стартует', async () => {
    kernelMock.createTask.mockResolvedValueOnce({
      created: false,
      existing: { ...baseTask, state: 'running', idempotency_key: 'k1', input_hash: 'h1' },
    });
    const { executeGovernedAction } = await import('@/lib/agents/kernel/governed-action');
    const execute = vi.fn();

    const res = await executeGovernedAction({
      principal: cronPrincipal,
      capability: 'evo.run',
      idempotencyKey: 'k1',
      inputHash: 'h1',
      execute,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('уже исполняется');
    expect(execute).not.toHaveBeenCalled();
  });

  it('тот же ключ с другим входом → детерминированный конфликт', async () => {
    kernelMock.createTask.mockResolvedValueOnce({
      created: false,
      existing: { ...baseTask, state: 'succeeded', idempotency_key: 'k1', input_hash: 'h1' },
    });
    const { executeGovernedAction } = await import('@/lib/agents/kernel/governed-action');
    const execute = vi.fn();

    const res = await executeGovernedAction({
      principal: cronPrincipal,
      capability: 'evo.run',
      idempotencyKey: 'k1',
      inputHash: 'h2-другой',
      execute,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('конфликт идемпотентности');
    expect(execute).not.toHaveBeenCalled();
  });

  it('незнакомая capability → rejected автоматически, очередь approval НЕ создаётся', async () => {
    kernelMock.createTask.mockResolvedValueOnce({ created: true, task: { ...baseTask, state: 'rejected' } });
    const { executeGovernedAction } = await import('@/lib/agents/kernel/governed-action');
    const execute = vi.fn();

    const res = await executeGovernedAction({
      principal: cronPrincipal,
      capability: 'unknown.capability',
      execute,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.state).toBe('rejected');
    expect(execute).not.toHaveBeenCalled();
    const types = kernelMock.appendEvent.mock.calls.map((c) => c[2]);
    expect(types).toContain('policy_denied');
  });

  it('запрещённая capability → rejected + policy_denied', async () => {
    kernelMock.createTask.mockResolvedValueOnce({ created: true, task: { ...baseTask, state: 'rejected' } });
    const { executeGovernedAction } = await import('@/lib/agents/kernel/governed-action');
    const execute = vi.fn();

    const res = await executeGovernedAction({
      principal: cronPrincipal,
      capability: 'payment.execute',
      execute,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.state).toBe('rejected');
    expect(execute).not.toHaveBeenCalled();
  });
});
