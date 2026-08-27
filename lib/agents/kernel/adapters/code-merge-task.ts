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
 */

import { pool } from '@/lib/db-pool';
import { appendEvent, claimTaskById, createTask, transition } from '../kernel';
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
 * Задача для PR существует и находится в running. Ключа идемпотентности нет
 * намеренно: reopened-PR после rejected законно получает НОВУЮ задачу, а
 * дедуп живых держит findActiveCodeMergeTask (гонка двух sweep'ов закрыта
 * concurrency workflow).
 */
export async function ensureCodeMergeTask(
  repo: string,
  prNumber: number,
  title: string,
  link?: { parentTaskId?: string; traceId?: string },
): Promise<AgentTask> {
  const existing = await findActiveCodeMergeTask(repo, prNumber);
  if (existing) return existing;

  const created = await createTask({
    principal: ACTOR,
    capability: CAPABILITY,
    risk: 'safe',
    state: 'queued',
    resource: { type: 'github_pr', id: prResourceId(repo, prNumber) },
    parentTaskId: link?.parentTaskId,
    traceId: link?.traceId,
    details: { pr: prNumber, repo, title },
  });
  if (!created.created) return created.existing;
  const claimed = await claimTaskById(created.task.id, ACTOR);
  return claimed ?? created.task;
}

/** Событие pr_* ровно один раз на (event, head_sha). */
export async function recordPrEventOnce(
  taskId: string,
  eventType: 'pr_opened' | 'pr_merged' | 'pr_rejected' | 'note',
  fingerprint: { repo: string; pr: number; head_sha: string; kind?: string },
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM agent_events
     WHERE task_id = $1 AND event_type = $2
       AND details->>'head_sha' = $3
       AND COALESCE(details->>'kind', '') = COALESCE($4, '')
     LIMIT 1`,
    [taskId, eventType, fingerprint.head_sha, fingerprint.kind ?? null],
  );
  if (rows.length > 0) return false;
  await appendEvent(taskId, ACTOR, eventType, { ...fingerprint });
  return true;
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
