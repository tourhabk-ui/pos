/**
 * Volcano OS — интеграционные тесты ядра на НАСТОЯЩЕМ PostgreSQL.
 *
 * Regex- и mock-сторожа (agent-kernel.test.ts) держат форму кода; здесь
 * проверяется транзакционное ПОВЕДЕНИЕ, которое моками не доказывается:
 * конкурентная идемпотентность, захват по id против чужих задач, SKIP
 * LOCKED двух worker'ов, pre_commit по текущему состоянию ресурса и
 * append-only журнала на уровне БД.
 *
 * Запуск ТРЕБУЕТ базы: KERNEL_PG_TEST_URL=postgresql://user:pass@host/db.
 * Без неё файл честно пропускается с причиной (третье состояние §4.0 —
 * «не прогнано», а не «прошло»); в CI базу даёт job kernel-pg с сервисом
 * postgres:16, локально — кластер PostgreSQL 16.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;

if (!PG_URL) {
  // eslint-disable-next-line no-console
  console.warn('[agent-kernel.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты ядра ПРОПУЩЕНЫ (не прогнаны, а не зелёные)');
}

// Пул ядра читает DATABASE_URL лениво — задаём ДО первого dynamic import.
if (PG_URL) {
  process.env.DATABASE_URL = PG_URL;
  process.env.DATABASE_SSL = 'false';
}

type Kernel = typeof import('@/lib/agents/kernel');

withPg('Agent Kernel на настоящем PostgreSQL', () => {
  let kernel: Kernel;
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: PG_URL, max: 12 });

    // Миграции ядра — из тех же файлов, что накатывает прод; повторный
    // прогон обязан быть no-op (идемпотентность проверяется здесь же).
    for (const f of ['917_agent_kernel.sql', '918_kernel_autonomy.sql', '918_kernel_autonomy.sql', '920_agent_tasks_active_resource_index.sql', '922_agent_effects.sql']) {
      await pool.query(readFileSync(join(process.cwd(), 'migrations', f), 'utf-8'));
    }
    // Минимальная operator_tours — для policy-проверки ownership.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS operator_tours (
        id SERIAL PRIMARY KEY,
        operator_id INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT 't',
        base_price NUMERIC NOT NULL DEFAULT 0,
        is_published BOOLEAN NOT NULL DEFAULT false,
        deleted_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    kernel = await import('@/lib/agents/kernel');
  });

  afterAll(async () => {
    const { pool: kernelPool } = await import('@/lib/db-pool');
    await kernelPool.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
  });

  beforeEach(async () => {
    // TRUNCATE не вызывает row-триггеры — обслуживание возможно, построчная
    // правка истории по-прежнему запрещена (проверяется тестом ниже).
    await pool.query('TRUNCATE agent_effects, agent_events, agent_tasks CASCADE');
    await pool.query('TRUNCATE operator_tours RESTART IDENTITY');
  });

  const principal = { type: 'cron', id: 'pg-test' } as const;

  it('конкуренция за один ключ/hash: ровно один эффект', async () => {
    let effects = 0;
    const run = () => kernel.executeGovernedAction({
      principal,
      capability: 'evo.run',
      idempotencyKey: 'k-parallel',
      inputHash: 'h1',
      execute: async () => {
        effects += 1;
        await new Promise((r) => setTimeout(r, 80));
        return 'done';
      },
    });

    const results = await Promise.all(Array.from({ length: 8 }, run));

    expect(effects, 'эффект обязан исполниться ровно один раз').toBe(1);
    const okReal = results.filter((r) => r.ok && !r.duplicate);
    expect(okReal).toHaveLength(1);
    // Остальные — existing/in-progress (конкурент жив) или duplicate (успел
    // завершиться): оба исхода легальны, двойного эффекта нет.
    for (const r of results) {
      if (r.ok && !r.duplicate) continue;
      if (r.ok && r.duplicate) continue;
      expect(r.reason).toMatch(/уже исполняется|конфликт/);
    }
  });

  it('тот же ключ, другой hash до завершения первого: конфликт, эффект не стартует', async () => {
    let secondEffect = 0;
    const first = kernel.executeGovernedAction({
      principal,
      capability: 'evo.run',
      idempotencyKey: 'k-conflict',
      inputHash: 'h1',
      execute: async () => { await new Promise((r) => setTimeout(r, 150)); return 1; },
    });
    await new Promise((r) => setTimeout(r, 30));
    const second = await kernel.executeGovernedAction({
      principal,
      capability: 'evo.run',
      idempotencyKey: 'k-conflict',
      inputHash: 'h2-другой',
      execute: async () => { secondEffect += 1; return 2; },
    });

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toContain('конфликт идемпотентности');
    expect(secondEffect).toBe(0);
    await first;
  });

  it('после провала ключ свободен: осознанный retry заводит новую задачу', async () => {
    const failed = await kernel.executeGovernedAction({
      principal,
      capability: 'evo.run',
      idempotencyKey: 'k-retry',
      inputHash: 'h1',
      execute: async () => { throw new Error('boom'); },
    });
    expect(failed.ok).toBe(false);

    let effects = 0;
    const retry = await kernel.executeGovernedAction({
      principal,
      capability: 'evo.run',
      idempotencyKey: 'k-retry',
      inputHash: 'h1',
      execute: async () => { effects += 1; return 'ok'; },
    });
    expect(retry.ok).toBe(true);
    expect(effects).toBe(1);
  });

  it('claimTaskById берёт СВОЮ задачу, а не старейшую той же capability', async () => {
    const a = await kernel.createTask({ principal: 'cron:pg-test', capability: 'evo.run', risk: 'safe', state: 'queued' });
    const b = await kernel.createTask({ principal: 'cron:pg-test', capability: 'evo.run', risk: 'safe', state: 'queued' });
    if (!a.created || !b.created) throw new Error('задачи не созданы');

    // Захватываем ВТОРУЮ: при захвате «старейшей» вернулась бы первая.
    const claimed = await kernel.claimTaskById(b.task.id, 'cron:pg-test');
    expect(claimed?.id).toBe(b.task.id);

    const aState = await pool.query(`SELECT state FROM agent_tasks WHERE id = $1`, [a.task.id]);
    expect(aState.rows[0].state).toBe('queued');
  });

  it('два worker-а: одну queued-задачу получает ровно один (SKIP LOCKED)', async () => {
    const t = await kernel.createTask({ principal: 'cron:pg-test', capability: 'evo.run', risk: 'safe', state: 'queued' });
    if (!t.created) throw new Error('задача не создана');

    const [w1, w2] = await Promise.all([
      kernel.claimNextTask('evo.run', 'worker-1'),
      kernel.claimNextTask('evo.run', 'worker-2'),
    ]);
    const claimedCount = [w1, w2].filter(Boolean).length;
    expect(claimedCount).toBe(1);
  });

  it('pre_commit судит по ТЕКУЩЕМУ состоянию: чужой тур — deny до мутации', async () => {
    await pool.query(`INSERT INTO operator_tours (operator_id, title) VALUES (2, 'чужой тур')`);
    let effects = 0;

    const res = await kernel.executeGovernedAction({
      principal: { type: 'operator', id: '1' },
      capability: 'tour.set_published',
      resource: { type: 'tour', id: '1' },
      execute: async () => { effects += 1; return 'x'; },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.state).toBe('failed_terminal');
      expect(res.reason).toContain('другому оператору');
    }
    expect(effects, 'эффект не имеет права стартовать при deny').toBe(0);
  });

  it('незнакомая capability: rejected со следом, эффект не стартует', async () => {
    let effects = 0;
    const res = await kernel.executeGovernedAction({
      principal,
      capability: 'totally.unknown',
      execute: async () => { effects += 1; return 'x'; },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.state).toBe('rejected');
    expect(effects).toBe(0);

    const denied = await pool.query(
      `SELECT event_type FROM agent_events e
       JOIN agent_tasks t ON t.id = e.task_id
       WHERE t.capability = 'totally.unknown' AND e.event_type = 'policy_denied'`,
    );
    expect(denied.rowCount).toBe(1);
  });

  it('agent_events: UPDATE и DELETE отклоняет сама БД', async () => {
    const t = await kernel.createTask({ principal: 'cron:pg-test', capability: 'evo.run', risk: 'safe', state: 'queued' });
    if (!t.created) throw new Error('задача не создана');

    await expect(pool.query(`UPDATE agent_events SET actor = 'tamper' WHERE task_id = $1`, [t.task.id]))
      .rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM agent_events WHERE task_id = $1`, [t.task.id]))
      .rejects.toThrow(/append-only/);
  });

  it('code.merge: ready → merged идемпотентно; новый commit снимает readiness', async () => {
    const cm = await import('@/lib/agents/kernel/adapters/code-merge-task');
    const repo = 'tourhabk-ui/pos';

    const task = await cm.ensureCodeMergeTask(repo, 4242, 'тестовый agent-PR');
    expect(task.state).toBe('running');

    // Повторный ensure не плодит задач.
    const again = await cm.ensureCodeMergeTask(repo, 4242, 'тестовый agent-PR');
    expect(again.id).toBe(task.id);

    // readiness → awaiting_merge; повтор — no-op.
    const ready1 = await cm.markReady({ ...task, state: 'running' }, 'sha-1', {});
    expect(ready1.changed).toBe(true);
    const ready2 = await cm.markReady({ ...task, state: 'awaiting_merge' }, 'sha-1', {});
    expect(ready2.changed).toBe(false);

    // Новый commit снимает readiness.
    const un = await cm.markUnready({ ...task, state: 'awaiting_merge' }, 'новый commit');
    expect(un.changed).toBe(true);
    expect(un.state).toBe('running');

    // Снова готов, человек мержит; повтор callback'а — no-op и одно событие.
    await cm.markReady({ ...task, state: 'running' }, 'sha-2', {});
    const fp = { repo, pr: 4242, head_sha: 'sha-2' };
    const m1 = await cm.completePr({ ...task, state: 'awaiting_merge' }, 'merged', fp);
    expect(m1.changed).toBe(true);
    expect(m1.state).toBe('succeeded');
    const m2 = await cm.completePr({ ...task, state: 'succeeded' }, 'merged', fp);
    expect(m2.changed).toBe(false);

    const events = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM agent_events
       WHERE task_id = $1 AND event_type = 'pr_merged'`,
      [task.id],
    );
    expect(events.rows[0].cnt).toBe(1);

    // Задача терминальна; reopened-PR получил бы НОВУЮ задачу.
    const fresh = await cm.ensureCodeMergeTask(repo, 4242, 'reopened');
    expect(fresh.id).not.toBe(task.id);
  });

  it('code.merge: два почти одновременных ensureCodeMergeTask по одному PR — ровно одна живая задача (без check-then-act)', async () => {
    // Аудит 28.08: раньше дедуп держал ТОЛЬКО SELECT ДО INSERT — окно гонки
    // ровно там, где opened+synchronize одного PR приходят почти
    // одновременно. Проверяем атомарность индекса 920 двумя параллельными
    // вызовами, не одной последовательной парой (та гонку не покажет).
    const cm = await import('@/lib/agents/kernel/adapters/code-merge-task');
    const repo = 'tourhabk-ui/pos';

    const [a, b] = await Promise.all([
      cm.ensureCodeMergeTask(repo, 5151, 'race a'),
      cm.ensureCodeMergeTask(repo, 5151, 'race b'),
    ]);
    expect(a.id).toBe(b.id);

    const { rows } = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM agent_tasks
       WHERE capability = 'code.merge' AND resource_type = 'github_pr' AND resource_id = $1`,
      [`${repo}#5151`],
    );
    expect(rows[0].cnt).toBe('1');
  });

  it('recordPrEventOnce: два почти одновременных вызова того же события — ровно одна строка (без check-then-act)', async () => {
    const cm = await import('@/lib/agents/kernel/adapters/code-merge-task');
    const repo = 'tourhabk-ui/pos';
    const task = await cm.ensureCodeMergeTask(repo, 6161, 'дубль события');
    const fp = { repo, pr: 6161, head_sha: 'sha-race' };

    const results = await Promise.all([
      cm.recordPrEventOnce(task.id, 'pr_opened', fp),
      cm.recordPrEventOnce(task.id, 'pr_opened', fp),
    ]);
    // Ровно один вызов реально вставил строку, второй увидел конфликт.
    expect(results.filter(Boolean).length).toBe(1);

    const { rows } = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM agent_events
       WHERE task_id = $1 AND event_type = 'pr_opened' AND details->>'head_sha' = 'sha-race'`,
      [task.id],
    );
    expect(rows[0].cnt).toBe('1');
  });

  it('успешный путь: события идут started→committed, seq без дыр, терминал succeeded', async () => {
    const res = await kernel.executeGovernedAction({
      principal,
      capability: 'evo.run',
      execute: async () => 'ok',
      summarize: () => 'итог',
    });
    expect(res.ok).toBe(true);
    if (!res.ok || res.duplicate) throw new Error('ожидался успех');

    const events = await pool.query<{ seq: number; event_type: string }>(
      `SELECT seq, event_type FROM agent_events WHERE task_id = $1 ORDER BY seq`,
      [res.taskId],
    );
    const seqs = events.rows.map((r) => r.seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    const types = events.rows.map((r) => r.event_type);
    expect(types).toContain('effect_started');
    expect(types).toContain('effect_committed');

    const st = await pool.query(`SELECT state FROM agent_tasks WHERE id = $1`, [res.taskId]);
    expect(st.rows[0].state).toBe('succeeded');
  });

  /**
   * Concurrency-guard /api/cron/evo (ревью 28.08): pg_try_advisory_lock —
   * та же техника, что закрывает гонку овербукинга в
   * app/api/accommodations/[id]/book/route.ts (см. README), только session-
   * level (`_xact_`-вариант держал бы транзакцию открытой все 120с прогона
   * оркестратора — риск для БД). Проверяется здесь той же SQL-конструкцией,
   * что использует роут (`hashtext($1)` на одном ключе), двумя РЕАЛЬНЫМИ
   * соединениями — ровно то поведение, которое check-then-act не гарантирует
   * никогда: атомарность даёт сам Postgres, а не порядок наших запросов.
   */
  it('pg_try_advisory_lock: конкурентный захват атомарен — ровно один получает true', async () => {
    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      const [a, b] = await Promise.all([
        clientA.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, ['evo.run.pg-test']),
        clientB.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, ['evo.run.pg-test']),
      ]);
      const locked = [a.rows[0].locked, b.rows[0].locked];
      expect(locked.filter(Boolean)).toHaveLength(1);
    } finally {
      await clientA.query(`SELECT pg_advisory_unlock(hashtext($1))`, ['evo.run.pg-test']).catch(() => undefined);
      await clientB.query(`SELECT pg_advisory_unlock(hashtext($1))`, ['evo.run.pg-test']).catch(() => undefined);
      clientA.release();
      clientB.release();
    }
  });

  it('pg_try_advisory_lock: после unlock следующий захват снова успешен', async () => {
    const clientA = await pool.connect();
    try {
      const first = await clientA.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, ['evo.run.pg-test-2'],
      );
      expect(first.rows[0].locked).toBe(true);
      await clientA.query(`SELECT pg_advisory_unlock(hashtext($1))`, ['evo.run.pg-test-2']);

      const clientB = await pool.connect();
      try {
        // Освободившийся ключ — не «навсегда занят». Аварийный процесс,
        // державший lock, тоже освобождает его сам собой при закрытии
        // соединения (session-level), поэтому очередь не замуровывается.
        const second = await clientB.query<{ locked: boolean }>(
          `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, ['evo.run.pg-test-2'],
        );
        expect(second.rows[0].locked).toBe(true);
        await clientB.query(`SELECT pg_advisory_unlock(hashtext($1))`, ['evo.run.pg-test-2']);
      } finally {
        clientB.release();
      }
    } finally {
      clientA.release();
    }
  });

  it('beginEffect: два почти одновременных вызова с тем же ключом — ровно один started, второй видит pending', async () => {
    const effects = await import('@/lib/agents/kernel/effects');
    const created = await kernel.createTask({ principal: 'cron:pg-test', capability: 'evo.run', risk: 'safe', state: 'queued' });
    if (!created.created) throw new Error('задача не создана');

    const [a, b] = await Promise.all([
      effects.beginEffect(created.task.id, 'effect-race', { n: 1 }),
      effects.beginEffect(created.task.id, 'effect-race', { n: 2 }),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['pending_unknown', 'started']);

    const { rows } = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM agent_effects WHERE task_id = $1 AND effect_key = 'effect-race'`,
      [created.task.id],
    );
    expect(rows[0].cnt).toBe('1');
  });

  it('beginEffect после commitEffect отдаёт already_committed, а не вторую попытку', async () => {
    const effects = await import('@/lib/agents/kernel/effects');
    const created = await kernel.createTask({ principal: 'cron:pg-test', capability: 'evo.run', risk: 'safe', state: 'queued' });
    if (!created.created) throw new Error('задача не создана');

    const started = await effects.beginEffect(created.task.id, 'effect-once', {});
    if (started.outcome !== 'started') throw new Error('ожидался started');
    const committed = await effects.commitEffect(started.effect.id, 'https://example.com/pr/1');
    expect(committed.ok).toBe(true);

    const again = await effects.beginEffect(created.task.id, 'effect-once', {});
    expect(again.outcome).toBe('already_committed');
    if (again.outcome === 'already_committed') {
      expect(again.effect.external_ref).toBe('https://example.com/pr/1');
    }
  });

  it('commitEffect/failEffect: guard WHERE status=pending — повторный переход не проходит', async () => {
    const effects = await import('@/lib/agents/kernel/effects');
    const created = await kernel.createTask({ principal: 'cron:pg-test', capability: 'evo.run', risk: 'safe', state: 'queued' });
    if (!created.created) throw new Error('задача не создана');

    const started = await effects.beginEffect(created.task.id, 'effect-guard', {});
    if (started.outcome !== 'started') throw new Error('ожидался started');
    const first = await effects.commitEffect(started.effect.id, 'ref');
    expect(first.ok).toBe(true);
    const second = await effects.commitEffect(started.effect.id, 'ref-2');
    expect(second.ok).toBe(false);
    const asFailed = await effects.failEffect(started.effect.id, 'поздний провал');
    expect(asFailed.ok).toBe(false);
  });

  it('findStuckEffects: pending дольше окна — виден; committed — не виден', async () => {
    const effects = await import('@/lib/agents/kernel/effects');
    const created = await kernel.createTask({ principal: 'cron:pg-test', capability: 'evo.run', risk: 'safe', state: 'queued' });
    if (!created.created) throw new Error('задача не создана');

    const stuck = await effects.beginEffect(created.task.id, 'effect-stuck', {});
    if (stuck.outcome !== 'started') throw new Error('ожидался started');
    await pool.query(`UPDATE agent_effects SET created_at = NOW() - interval '30 minutes' WHERE id = $1`, [stuck.effect.id]);

    const fresh = await effects.beginEffect(created.task.id, 'effect-fresh', {});
    if (fresh.outcome !== 'started') throw new Error('ожидался started');
    await effects.commitEffect(fresh.effect.id, 'ref');

    const found = await effects.findStuckEffects(15);
    const ids = found.map((e) => e.id);
    expect(ids).toContain(stuck.effect.id);
    expect(ids).not.toContain(fresh.effect.id);
  });
});
