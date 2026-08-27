/**
 * Agent Kernel v1 — задачи, переходы, атомарный захват.
 *
 * Инварианты, обеспеченные ЗДЕСЬ, а не дисциплиной вызывающих:
 *
 * 1. Переход состояния возможен только по матрице ALLOWED_TRANSITIONS, и
 *    смена состояния фиксируется в agent_events ТОЙ ЖЕ транзакцией —
 *    состояние без события в истории не существует. Гонку двух переходов
 *    решает БД: UPDATE сторожит прежнее состояние в WHERE, проигравший
 *    получает rowCount 0 и честный отказ, а не второе событие.
 * 2. Захват атомарен и фиксирует lease ДО исполнения эффекта: один UPDATE
 *    queued → running через FOR UPDATE SKIP LOCKED — два исполнителя не
 *    возьмут одну задачу (тот же приём, что в execute-all после P0 27.08).
 * 3. Транзакции БД короткие и только вокруг записей kernel: НИКОГДА вокруг
 *    LLM/API-вызовов — эффект исполняется между переходами, не внутри них.
 * 4. agent_events — append-only: здесь нет ни UPDATE, ни DELETE по журналу
 *    (сторож держит это по всему репо), а в БД их режет триггер миграции 917.
 *    seq считается атомарно через agent_tasks.last_seq — (task_id, seq)
 *    уникален, дыр и дублей в нумерации нет по построению.
 */

import { randomUUID } from 'node:crypto';
import { pool } from '@/lib/db-pool';
import {
  type AgentTask,
  type TaskRisk,
  type TaskState,
  isTransitionAllowed,
} from './types';

export const POLICY_VERSION = 'kernel-v1';

const TASK_COLUMNS = `id, parent_task_id, trace_id, principal, capability,
  resource_type, resource_id, risk, state, idempotency_key, input_hash,
  attempt, summary`;

interface TaskRow extends AgentTask {
  [key: string]: unknown;
}

export type KernelEventType =
  | 'transition'
  | 'effect_started'
  | 'effect_committed'
  | 'policy_denied'
  | 'note';

export interface CreateTaskInput {
  principal: string;
  capability: string;
  risk: TaskRisk;
  state: Extract<TaskState, 'proposed' | 'awaiting_approval' | 'queued' | 'rejected'>;
  resource?: { type: string; id: string };
  idempotencyKey?: string;
  parentTaskId?: string;
  traceId?: string;
  inputHash?: string;
  approvalId?: string;
  details?: Record<string, unknown>;
}

/** Создать задачу; событие рождения пишется той же транзакцией (seq=1). */
export async function createTask(input: CreateTaskInput): Promise<AgentTask> {
  const traceId = input.traceId ?? randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<TaskRow>(
      `INSERT INTO agent_tasks (
         parent_task_id, trace_id, principal, capability,
         resource_type, resource_id, risk, state,
         idempotency_key, policy_version, input_hash, approval_id, last_seq
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1)
       RETURNING ${TASK_COLUMNS}`,
      [
        input.parentTaskId ?? null,
        traceId,
        input.principal,
        input.capability,
        input.resource?.type ?? null,
        input.resource?.id ?? null,
        input.risk,
        input.state,
        input.idempotencyKey ?? null,
        POLICY_VERSION,
        input.inputHash ?? null,
        input.approvalId ?? null,
      ],
    );
    const task = rows[0];
    await client.query(
      `INSERT INTO agent_events (task_id, trace_id, seq, event_type, from_state, to_state, actor, details)
       VALUES ($1, $2, 1, 'transition', NULL, $3, $4, $5)`,
      [task.id, traceId, task.state, input.principal, JSON.stringify({ created: true, ...input.details })],
    );
    await client.query('COMMIT');
    return task;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface TransitionResult {
  ok: boolean;
  reason?: string;
}

/** Перевести задачу в новое состояние (короткая транзакция: UPDATE + событие). */
export async function transition(
  taskId: string,
  from: TaskState,
  to: TaskState,
  actor: string,
  details?: Record<string, unknown>,
): Promise<TransitionResult> {
  if (!isTransitionAllowed(from, to)) {
    return { ok: false, reason: `переход ${from} → ${to} не разрешён матрицей` };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query<{ trace_id: string; last_seq: number }>(
      `UPDATE agent_tasks
       SET state = $3,
           last_seq = last_seq + 1,
           updated_at = NOW(),
           summary = COALESCE($4, summary),
           attempt = attempt + CASE WHEN $3 = 'queued' AND $2 = 'failed_retryable' THEN 1 ELSE 0 END
       WHERE id = $1 AND state = $2
       RETURNING trace_id, last_seq`,
      [taskId, from, to, typeof details?.summary === 'string' ? details.summary : null],
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: `задача не в состоянии ${from} — переход не выполнен` };
    }
    await client.query(
      `INSERT INTO agent_events (task_id, trace_id, seq, event_type, from_state, to_state, actor, details)
       VALUES ($1, $2, $3, 'transition', $4, $5, $6, $7)`,
      [taskId, upd.rows[0].trace_id, upd.rows[0].last_seq, from, to, actor, JSON.stringify(details ?? {})],
    );
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `переход не записан: ${msg}` };
  } finally {
    client.release();
  }
}

/**
 * Событие без смены состояния: effect_started / effect_committed / note /
 * policy_denied. Для внешнего side effect связка started/committed даёт
 * наблюдаемость, но БЕЗ outbox не даёт exactly-once: окно сбоя между
 * внешним commit и записью события остаётся — v1 это не обещает и не
 * скрывает (решение владельца 27.08; outbox — отдельным этапом).
 */
export async function appendEvent(
  taskId: string,
  actor: string,
  eventType: Exclude<KernelEventType, 'transition'>,
  details?: Record<string, unknown>,
): Promise<{ ok: boolean; reason?: string }> {
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
      return { ok: false, reason: 'задача не найдена' };
    }
    await client.query(
      `INSERT INTO agent_events (task_id, trace_id, seq, event_type, from_state, to_state, actor, details)
       VALUES ($1, $2, $3, $4, NULL, NULL, $5, $6)`,
      [taskId, upd.rows[0].trace_id, upd.rows[0].last_seq, eventType, actor, JSON.stringify(details ?? {})],
    );
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    client.release();
  }
}

export const DEFAULT_LEASE_SECONDS = 300;

/**
 * Атомарный захват одной queued-задачи данной capability: единственный
 * UPDATE queued → running фиксирует claimed_by и lease ДО исполнения
 * эффекта. null — «нечего брать», честный исход, не ошибка. Просроченный
 * lease НЕ перехватывается здесь: возврат зависшей задачи в queued —
 * отдельное явное действие человека/крона, захват и реанимация не
 * смешиваются.
 */
export async function claimTask(
  capability: string,
  claimedBy: string,
  leaseSeconds: number = DEFAULT_LEASE_SECONDS,
): Promise<AgentTask | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<TaskRow & { last_seq: number }>(
      `UPDATE agent_tasks a
       SET state = 'running', claimed_by = $2,
           lease_until = NOW() + ($3 || ' seconds')::interval,
           last_seq = last_seq + 1,
           updated_at = NOW()
       WHERE a.id = (
         SELECT id FROM agent_tasks
         WHERE capability = $1 AND state = 'queued'
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING ${TASK_COLUMNS}, last_seq`,
      [capability, claimedBy, String(leaseSeconds)],
    );
    const task = rows[0];
    if (!task) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query(
      `INSERT INTO agent_events (task_id, trace_id, seq, event_type, from_state, to_state, actor, details)
       VALUES ($1, $2, $3, 'transition', 'queued', 'running', $4, $5)`,
      [task.id, task.trace_id, task.last_seq, claimedBy, JSON.stringify({ lease_seconds: leaseSeconds })],
    );
    await client.query('COMMIT');
    return task;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Задача с этим ключом идемпотентности (успешная — приоритетно). */
export async function findByIdempotencyKey(key: string): Promise<AgentTask | null> {
  const { rows } = await pool.query<TaskRow>(
    `SELECT ${TASK_COLUMNS}
     FROM agent_tasks
     WHERE idempotency_key = $1
     ORDER BY (state = 'succeeded') DESC, created_at DESC
     LIMIT 1`,
    [key],
  );
  return rows[0] ?? null;
}
