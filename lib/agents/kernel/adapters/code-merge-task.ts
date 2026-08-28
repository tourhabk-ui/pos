/**
 * Volcano OS — контур code.merge: жизненный цикл agent-PR в ядре.
 *
 * Единственный human gate системы: изменение кода/политики готовится
 * агентом, а решение принимает человек мержем PR в GitHub. Задача
 * capability 'code.merge' ОТРАЖАЕТ этот путь, не исполняет его — эффекта
 * слияния у неё нет по построению, merge делает только человек.
 *
 * Lifecycle:
 *   queued → running        PR открыт, агент дорабатывает (draft/красный CI)
 *   running → awaiting_merge readiness-gate пройден (не draft, CI зелёный)
 *   awaiting_merge → running новый commit снял readiness
 *   awaiting_merge|running → succeeded  PR merged (человек решил «да»)
 *   awaiting_merge|running → rejected   PR закрыт без merge («нет»)
 *
 * Идемпотентность callback'ов — по (event, head_sha): повтор webhook'а или
 * re-run workflow не пишет второе событие и не двигает состояние (переход
 * сторожится WHERE state=from — проигравший получает честный no-op).
 * Дедуп задачи по PR — атомарный уникальный индекс 920, не check-then-act
 * (см. `ensureCodeMergeTask`); дедуп событий — атомарный уникальный индекс
 * по выражению, тоже 920 (см. `recordPrEventOnce`).
 */

import { randomUUID } from 'node:crypto';
import { pool } from '@/lib/db-pool';
import { appendEvent, claimTaskById, POLICY_VERSION, transition } from '../kernel';
import type { AgentTask, TaskState } from '../types';

const CAPABILITY = 'code.merge';
const ACTOR = 'cron:merge-gate';

interface TaskRow extends AgentTask { [k: string]: unknown }

const TASK_COLUMNS = `id, parent_task_id, trace_id, principal, capability,
  resource_type, resource_id, risk, state, idempotency_key, input_hash,
  attempt, summary`;

export function prResourceId(repo: string, prNumber: number): string {
  return `${repo}#${prNumber}`;
}

/** Живая (нетерминальная) задача этого PR; null — её нет. */
export async function findActiveCodeMergeTask(repo: string, prNumber: number): Promise<AgentTask | null> {
  const { rows } = await pool.query<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM agent_tasks
     WHERE capability = $1 AND resource_type = 'github_pr' AND resource_id = $2
       AND state NOT IN ('succeeded','failed_terminal','cancelled','rejected')
     ORDER BY created_at DESC LIMIT 1`,
    [CAPABILITY, prResourceId(repo, prNumber)],
  );
  return rows[0] ?? null;
}

/** Последняя задача PR в любом состоянии — для поздних callback'ов. */
export async function findAnyCodeMergeTask(repo: string, prNumber: number): Promise<AgentTask | null> {
  const { rows } = await pool.query<TaskRow>(
    `SELECT ${TASK_COLUMNS} FROM agent_tasks
     WHERE capability = $1 AND resource_type = 'github_pr' AND resource_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [CAPABILITY, prResourceId(repo, prNumber)],
  );
  return rows[0] ?? null;
}

/**
 * Задача для PR существует и находится в running.
 *
 * Раньше дедуп держал ТОЛЬКО `findActiveCodeMergeTask` (SELECT ДО INSERT) —
 * check-then-act с окном гонки ровно там, где `opened` и `synchronize`
 * одного PR могут прийти почти одновременно (два webhook-события GitHub,
 * повторная доставка). Аудит 28.08 нашёл это окно открытым.
 *
 * Общий `idempotency_key` ядра (индекс 918) сюда НЕ подходит: тот держит
 * ключ занятым и после `succeeded` (правильно для одноразового внешнего
 * эффекта — второй такой же вызов не должен повториться), а у `code.merge`
 * `succeeded` = «PR смержен», и reopened-PR после этого обязан получить
 * НОВУЮ задачу (`agent-kernel.pg.test.ts`: «Задача терминальна; reopened-PR
 * получил бы НОВУЮ задачу» — уже проверено интеграционным тестом). Нужен
 * СВОЙ предикат: занято, только пока задача НЕ терминальна — ровно то же
 * условие, что у `findActiveCodeMergeTask`, но как атомарный `UNIQUE INDEX`
 * (миграция 920), а не SELECT. INSERT ниже целится в этот индекс через
 * `ON CONFLICT ... DO NOTHING` — гонка закрывается на уровне БД, не
 * check-then-act. `findActiveCodeMergeTask` остаётся быстрым read-путём:
 * не нужно открывать транзакцию, когда и так видно, что задача уже есть.
 */
export async function ensureCodeMergeTask(
  repo: string,
  prNumber: number,
  title: string,
  link?: { parentTaskId?: string; traceId?: string },
): Promise<AgentTask> {
  const existing = await findActiveCodeMergeTask(repo, prNumber);
  if (existing) return existing;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const traceId = link?.traceId ?? randomUUID();
    const { rows } = await client.query<TaskRow>(
      `INSERT INTO agent_tasks (
         parent_task_id, trace_id, principal, capability,
         resource_type, resource_id, risk, state, policy_version, last_seq
       ) VALUES ($1, $2, $3, $4, 'github_pr', $5, 'safe', 'queued', $6, 1)
       ON CONFLICT (capability, resource_type, resource_id)
         WHERE resource_type IS NOT NULL AND resource_id IS NOT NULL
           AND state NOT IN ('succeeded','failed_terminal','cancelled','rejected')
         DO NOTHING
       RETURNING ${TASK_COLUMNS}`,
      [link?.parentTaskId ?? null, traceId, ACTOR, CAPABILITY, prResourceId(repo, prNumber), POLICY_VERSION],
    );
    const task = rows[0];
    if (!task) {
      // Конкурент уже завёл живую задачу этого PR — отдаём её.
      await client.query('ROLLBACK');
      const found = await findActiveCodeMergeTask(repo, prNumber);
      if (found) return found;
      throw new Error(`конфликт задачи code.merge по PR ${prResourceId(repo, prNumber)}, но активный владелец не найден — повторите`);
    }
    await client.query(
      `INSERT INTO agent_events (task_id, trace_id, seq, event_type, from_state, to_state, actor, details)
       VALUES ($1, $2, 1, 'transition', NULL, $3, $4, $5)`,
      [task.id, traceId, task.state, ACTOR, JSON.stringify({ created: true, pr: prNumber, repo, title })],
    );
    await client.query('COMMIT');
    const claimed = await claimTaskById(task.id, ACTOR);
    return claimed ?? task;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Событие pr_* ровно один раз на (event, head_sha, kind).
 *
 * Раньше дедуп шёл SELECT ДО INSERT (check-then-act, окно гонки между двумя
 * почти одновременными webhook-доставками того же события). Теперь —
 * атомарный `INSERT ... ON CONFLICT DO NOTHING` по индексу 920
 * (`idx_agent_events_pr_dedup`), внутри своей короткой транзакции: тот же
 * паттерн bump-`last_seq`+INSERT, что у `kernel.ts`'s `appendEvent`, только с
 * явным `ON CONFLICT`. `rowCount` решает, было событие уже или нет — не
 * отдельный SELECT.
 */
export async function recordPrEventOnce(
  taskId: string,
  eventType: 'pr_opened' | 'pr_merged' | 'pr_rejected' | 'note',
  fingerprint: { repo: string; pr: number; head_sha: string; kind?: string },
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query<{ trace_id: string; last_seq: number }>(
      `UPDATE agent_tasks SET last_seq = last_seq + 1, updated_at = NOW()
       WHERE id = $1
       RETURNING trace_id, last_seq`,
      [taskId],
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    const ins = await client.query(
      `INSERT INTO agent_events (task_id, trace_id, seq, event_type, from_state, to_state, actor, details)
       VALUES ($1, $2, $3, $4, NULL, NULL, $5, $6)
       ON CONFLICT (task_id, event_type, (details->>'head_sha'), (COALESCE(details->>'kind', '')))
         WHERE details ? 'head_sha'
         DO NOTHING
       RETURNING id`,
      [taskId, upd.rows[0].trace_id, upd.rows[0].last_seq, eventType, ACTOR, JSON.stringify({ ...fingerprint })],
    );
    if ((ins.rowCount ?? 0) === 0) {
      // Уже записано конкурентом/раньше — last_seq не должен был двигаться
      // ради дубликата.
      await client.query('ROLLBACK');
      return false;
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface GateTransitionResult {
  changed: boolean;
  state: TaskState;
  reason?: string;
}

/** readiness пройден: running → awaiting_merge (повтор с тем же head_sha — no-op). */
export async function markReady(task: AgentTask, headSha: string, meta: Record<string, unknown>): Promise<GateTransitionResult> {
  if (task.state === 'awaiting_merge') return { changed: false, state: 'awaiting_merge' };
  const t = await transition(task.id, 'running', 'awaiting_merge', ACTOR, {
    summary: `готов к решению человека, head ${headSha.slice(0, 7)}`,
    head_sha: headSha,
    ...meta,
  });
  return t.ok
    ? { changed: true, state: 'awaiting_merge' }
    : { changed: false, state: task.state, reason: t.reason };
}

/** readiness снят (новый commit / красный CI): awaiting_merge → running. */
export async function markUnready(task: AgentTask, reason: string): Promise<GateTransitionResult> {
  if (task.state !== 'awaiting_merge') return { changed: false, state: task.state };
  const t = await transition(task.id, 'awaiting_merge', 'running', ACTOR, {
    summary: `readiness снят: ${reason}`,
  });
  return t.ok
    ? { changed: true, state: 'running' }
    : { changed: false, state: task.state, reason: t.reason };
}

/** Человек решил. merged → succeeded; закрыт без merge → rejected. Идемпотентно. */
export async function completePr(
  task: AgentTask,
  outcome: 'merged' | 'closed',
  fingerprint: { repo: string; pr: number; head_sha: string },
): Promise<GateTransitionResult> {
  const to = outcome === 'merged' ? 'succeeded' : 'rejected';
  const event = outcome === 'merged' ? 'pr_merged' : 'pr_rejected';

  if (task.state === 'succeeded' || task.state === 'rejected' || task.state === 'cancelled') {
    // Поздний повтор callback'а: состояние уже терминально — только
    // убеждаемся, что событие записано один раз.
    await recordPrEventOnce(task.id, event, fingerprint);
    return { changed: false, state: task.state };
  }

  const from = task.state === 'awaiting_merge' ? 'awaiting_merge' : 'running';
  const t = await transition(task.id, from, to, ACTOR, {
    summary: outcome === 'merged'
      ? `PR merged человеком (${fingerprint.head_sha.slice(0, 7)})`
      : 'PR закрыт без merge',
  });
  if (t.ok) {
    await recordPrEventOnce(task.id, event, fingerprint);
    return { changed: true, state: to };
  }
  return { changed: false, state: task.state, reason: t.reason };
}
