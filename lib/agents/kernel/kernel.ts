/**
 * Volcano OS — Agent Kernel: задачи, переходы, атомарный захват.
 *
 * Инварианты, обеспеченные ЗДЕСЬ, а не дисциплиной вызывающих:
 *
 * 1. Переход состояния возможен только по матрице ALLOWED_TRANSITIONS, и
 *    смена состояния фиксируется в agent_events ТОЙ ЖЕ транзакцией —
 *    состояние без события в истории не существует. Гонку двух переходов
 *    решает БД: UPDATE сторожит прежнее состояние в WHERE, проигравший
 *    получает rowCount 0 и честный отказ, а не второе событие.
 * 2. Захват атомарен и фиксирует lease ДО исполнения эффекта. Захват
 *    РАЗНЫЙ для разных ролей — и это не синонимы (исправление 27.08):
 *    - claimTaskById — inline-вызов захватывает СВОЮ задачу по id;
 *      захват «старейшей той же capability» под конкуренцией исполнял бы
 *      closure под чужим task_id;
 *    - claimNextTask — очередной worker берёт старейшую queued задачу
 *      через FOR UPDATE SKIP LOCKED; он обязан уметь восстановить payload
 *      задачи по её resource, у него нет «своего» closure.
 * 3. Идемпотентность решается БД, не SELECT'ом до INSERT: создание задачи
 *    с ключом — INSERT ... ON CONFLICT (частичный уникальный индекс 918 по
 *    активным+succeeded состояниям) DO NOTHING; конкурент получает
 *    существующую задачу, не вторую.
 * 4. Транзакции БД короткие и только вокруг записей kernel: НИКОГДА вокруг
 *    LLM/API-вызовов — эффект исполняется между переходами, не внутри них.
 * 5. agent_events — append-only: здесь нет ни UPDATE, ни DELETE по журналу
 *    (сторож держит это по всему репо), а в БД их режет триггер миграции 917.
 *    seq считается атомарно через agent_tasks.last_seq — (task_id, seq)
 *    уникален, дыр и дублей в нумерации нет по построению.
 */

import { randomUUID } from 'node:crypto';
import { pool } from '@/lib/db-pool';
import {
  IDEMPOTENCY_ACTIVE_STATES,
  type AgentTask,
  type TaskRisk,
  type TaskState,
  isTransitionAllowed,
} from './types';

export const POLICY_VERSION = 'volcano-os-v1';

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
  | 'pr_opened'
  | 'pr_merged'
  | 'pr_rejected'
  | 'note';

export interface CreateTaskInput {
  principal: string;
  capability: string;
  risk: TaskRisk;
  state: Extract<TaskState, 'proposed' | 'queued' | 'rejected'>;
  resource?: { type: string; id: string };
  idempotencyKey?: string;
  parentTaskId?: string;
  traceId?: string;
  inputHash?: string;
  details?: Record<string, unknown>;
}

export type CreateTaskOutcome =
  | { created: true; task: AgentTask }
  | { created: false; existing: AgentTask };

/**
 * Создать задачу; событие рождения пишется той же транзакцией (seq=1).
 *
 * С ключом идемпотентности создание атомарно: ON CONFLICT по частичному
 * уникальному индексу 918 — если у ключа уже есть активный/успешный
 * владелец, вставки не происходит и возвращается СУЩЕСТВУЮЩАЯ задача.
 * Сверка input_hash — дело вызывающего (governed-action): kernel отдаёт
 * факт, решение о конфликте принимает политика.
 */
export async function createTask(input: CreateTaskInput): Promise<CreateTaskOutcome> {
  const traceId = input.traceId ?? randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<TaskRow>(
      `INSERT INTO agent_tasks (
         parent_task_id, trace_id, principal, capability,
         resource_type, resource_id, risk, state,
         idempotency_key, policy_version, input_hash, last_seq
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1)
       ON CONFLICT (idempotency_key)
         WHERE idempotency_key IS NOT NULL
           AND state IN ('proposed','awaiting_approval','queued','running','awaiting_merge','succeeded')
         DO NOTHING
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
      ],
    );
    const task = rows[0];
    if (!task) {
      // Конфликт по ключу: владелец уже существует — отдаём его.
      await client.query('ROLLBACK');
      const existing = input.idempotencyKey
        ? await findActiveByIdempotencyKey(input.idempotencyKey)
        : null;
      if (!existing) {
        // Гонка «владелец завершился между INSERT и SELECT» — честный отказ,
        // вызывающий повторит создание сам.
        throw new Error(`конфликт идемпотентности по ключу, но владелец не найден — повторите создание`);
      }
      return { created: false, existing };
    }
    await client.query(
      `INSERT INTO agent_events (task_id, trace_id, seq, event_type, from_state, to_state, actor, details)
       VALUES ($1, $2, 1, 'transition', NULL, $3, $4, $5)`,
      [task.id, traceId, task.state, input.principal, JSON.stringify({ created: true, ...input.details })],
    );
    await client.query('COMMIT');
    return { created: true, task };
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
           -- Тип $2/$3 обязан выводиться ОДИНАКОВО во всех употреблениях:
           -- голое сравнение с литералом давало text против varchar-якоря
           -- state = $N — 42P08 «inconsistent types deduced», запрос не
           -- выполнялся НИКОГДА (§4.0, случай 24.08; пойман живым PG-тестом
           -- 27.08 — моки такое не ловят по построению). ::varchar совпадает
           -- с якорем; ::text снова дал бы конфликт.
           attempt = attempt + CASE WHEN $3::varchar = 'queued' AND $2::varchar = 'failed_retryable' THEN 1 ELSE 0 END
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
 * policy_denied / pr_*. Для внешнего side effect связка started/committed
 * даёт наблюдаемость, но БЕЗ outbox не даёт exactly-once: окно сбоя между
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
 * Inline-захват СВОЕЙ задачи по id: единственный UPDATE queued → running
 * фиксирует claimed_by и lease ДО исполнения эффекта. null — задачу уже
 * забрали/сняли (честный исход, не ошибка).
 */
export async function claimTaskById(
  taskId: string,
  claimedBy: string,
  leaseSeconds: number = DEFAULT_LEASE_SECONDS,
): Promise<AgentTask | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<TaskRow & { last_seq: number }>(
      `UPDATE agent_tasks
       SET state = 'running', claimed_by = $2,
           lease_until = NOW() + ($3 || ' seconds')::interval,
           last_seq = last_seq + 1,
           updated_at = NOW()
       WHERE id = $1 AND state = 'queued'
       RETURNING ${TASK_COLUMNS}, last_seq`,
      [taskId, claimedBy, String(leaseSeconds)],
    );
    const task = rows[0];
    if (!task) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query(
      `INSERT INTO agent_events (task_id, trace_id, seq, event_type, from_state, to_state, actor, details)
       VALUES ($1, $2, $3, 'transition', 'queued', 'running', $4, $5)`,
      [task.id, task.trace_id, task.last_seq, claimedBy, JSON.stringify({ lease_seconds: leaseSeconds, claim: 'by_id' })],
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

/**
 * Захват для ОЧЕРЕДНОГО worker'а: старейшая queued-задача данной capability
 * через FOR UPDATE SKIP LOCKED — два worker'а не возьмут одну задачу.
 * Использовать ТОЛЬКО из worker'а, который умеет восстановить payload задачи
 * по её resource; inline-вызовы захватывают свою задачу claimTaskById.
 */
export async function claimNextTask(
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
      [task.id, task.trace_id, task.last_seq, claimedBy, JSON.stringify({ lease_seconds: leaseSeconds, claim: 'next' })],
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

/** Активный/успешный владелец ключа идемпотентности (по предикату индекса 918). */
export async function findActiveByIdempotencyKey(key: string): Promise<AgentTask | null> {
  const states = IDEMPOTENCY_ACTIVE_STATES.map((s) => `'${s}'`).join(',');
  const { rows } = await pool.query<TaskRow>(
    `SELECT ${TASK_COLUMNS}
     FROM agent_tasks
     WHERE idempotency_key = $1 AND state IN (${states})
     LIMIT 1`,
    [key],
  );
  return rows[0] ?? null;
}

/**
 * Единственная незавершённая задача этой capability, чей lease ещё не истёк —
 * concurrency-guard там, где у действия НЕТ логического idempotency-ключа
 * (задание владельца 28.08, P0: защита /api/cron/evo от двойного прогона).
 *
 * evo.run — не retry одного и того же входа: каждый плановый прогон законно
 * новый, а не повтор. Значит блокировать нужно не по ключу (это заблокировало
 * бы ВСЕ будущие прогоны после первого succeeded — IDEMPOTENCY_ACTIVE_STATES
 * включает succeeded навсегда), а по факту «эта capability уже выполняется
 * ПРЯМО СЕЙЧАС». `lease_until > NOW()` — обязательное условие: аварийно
 * оборвавшийся процесс не переводит свою задачу в терминал (это делает только
 * `transition()`, а его некому вызвать после краха), и без проверки lease
 * очередь замуровалась бы навсегда первым же зависшим прогоном.
 */
export async function findActiveByCapability(capability: string): Promise<AgentTask | null> {
  const { rows } = await pool.query<TaskRow>(
    `SELECT ${TASK_COLUMNS}
     FROM agent_tasks
     WHERE capability = $1
       AND state IN ('queued','running')
       AND (lease_until IS NULL OR lease_until > NOW())
     ORDER BY created_at ASC
     LIMIT 1`,
    [capability],
  );
  return rows[0] ?? null;
}

/** Задача с этим ключом (успешная — приоритетно); для истории и разбора. */
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
