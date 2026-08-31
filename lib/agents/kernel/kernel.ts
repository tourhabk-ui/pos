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

/**
 * Почему задача не создалась. До 31.08 исход был один на два разных случая.
 *
 * `idempotency` — тот же логический вызов уже имеет владельца (индекс 918).
 * `resource` — ДРУГОЙ вызов занял тот же ресурс (индекс 920). Это разные
 * факты и разные слова человеку: в первом случае занят ключ, во втором — тур.
 */
export type CreateConflict = 'idempotency' | 'resource';

export type CreateTaskOutcome =
  | { created: true; task: AgentTask }
  | { created: false; existing: AgentTask; conflict: CreateConflict };

/**
 * Состояния, при которых ресурс считается занятым.
 *
 * ОБЯЗАНЫ совпадать с предикатом уникального индекса
 * `idx_agent_tasks_active_resource` (миграция 920): расхождение сделало бы
 * поиск владельца ложью — индекс не дал бы вставить, а мы бы «не нашли, кто
 * держит», и вызывающий получил бы выдуманную причину вместо настоящей.
 */
const RESOURCE_ACTIVE_STATES: readonly TaskState[] = [
  'proposed', 'awaiting_approval', 'queued', 'running', 'awaiting_merge',
  // `failed_retryable` тоже ДЕРЖИТ ресурс: предикат индекса исключает только
  // succeeded/failed_terminal/cancelled/rejected. Состояние сейчас мёртвое
  // (никто его не пишет — аудит 30.08, K-4), поэтому на практике разницы нет;
  // но если его оживят, поиск держателя обязан его видеть, иначе вернётся
  // «занято, а кем — не знаю». Сторож сверяет этот список с самой миграцией.
  'failed_retryable',
];

/** Имя индекса из миграции 920 — по нему опознаётся конфликт ресурса. */
const RESOURCE_INDEX = 'idx_agent_tasks_active_resource';

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
      return { created: false, existing, conflict: 'idempotency' };
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

    // ── Конфликт по РЕСУРСУ, а не по ключу ────────────────────────────────
    //
    // Миграция 920 завела уникальный индекс по (capability, resource_type,
    // resource_id) для всех НЕтерминальных задач. Её шапка говорит только про
    // `code.merge` — но в самом DDL условия на capability НЕТ, и индекс накрыл
    // всё, что несёт ресурс, включая `tour.*`.
    //
    // `ON CONFLICT (idempotency_key)` выше нарушение ДРУГОГО индекса не ловит:
    // Postgres поднимает 23505, оно уходило наверх необработанным. У `tour.*`
    // ключ инвокационный, поэтому два разных вызова по одному туру дают разные
    // ключи и один ресурс — то есть исключение вместо честного отказа, а пока
    // первая задача висит нетерминальной, тур недоступен агентскому пути
    // вообще (аудит 30.08, находка K-1).
    //
    // Индекс НЕ сужается: «одна активная задача на (capability, ресурс)» —
    // верный инвариант, пусть и полученный случайно. Чинится обработка.
    const pg = err as { code?: string; constraint?: string };
    if (pg?.code === '23505' && pg.constraint === RESOURCE_INDEX && input.resource) {
      const holder = await findActiveByResource(
        input.capability, input.resource.type, input.resource.id,
      );
      if (holder) return { created: false, existing: holder, conflict: 'resource' };
      // Владелец завершился между INSERT и SELECT — то же «повторите», что и
      // у ключа: выдумывать причину нельзя, а гонка разрешима повтором.
      throw new Error(
        `ресурс ${input.resource.type}:${input.resource.id} занят другой задачей ${input.capability}, но владелец не найден — повторите создание`,
      );
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Кто держит ресурс сейчас. Предикат совпадает с индексом 920 (см.
 * RESOURCE_ACTIVE_STATES) — иначе ответ был бы о другом множестве задач.
 */
export async function findActiveByResource(
  capability: string,
  resourceType: string,
  resourceId: string,
): Promise<AgentTask | null> {
  const states = RESOURCE_ACTIVE_STATES.map((s) => `'${s}'`).join(',');
  const { rows } = await pool.query<TaskRow>(
    `SELECT ${TASK_COLUMNS}
     FROM agent_tasks
     WHERE capability = $1 AND resource_type = $2 AND resource_id = $3
       AND state IN (${states})
     LIMIT 1`,
    [capability, resourceType, resourceId],
  );
  return rows[0] ?? null;
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

/**
 * Запас сверх lease, после которого задача считается брошенной.
 *
 * Lease по умолчанию 300 секунд (DEFAULT_LEASE_SECONDS), у роутов maxDuration
 * тоже 300 — значит живая работа физически не может идти дольше. Пятнадцать
 * минут сверху берутся не «на всякий случай», а чтобы жнец никогда не спорил
 * с настоящим исполнителем: терминальный переход у брошенной задачи и её
 * штатное завершение — это гонка, и выиграть её должен исполнитель.
 */
export const LEASE_REAP_GRACE_SECONDS = 900;

export interface ReapedTask {
  id: string;
  capability: string;
  resource: string | null;
  claimed_by: string | null;
}

/**
 * Вернуть в оборот задачи с протухшим lease.
 *
 * `claimed_by` и `lease_until` писались с самого начала и НЕ ЧИТАЛИСЬ нигде
 * (аудит 30.08, находка K-2): ни крон, ни Watchdog не возвращали брошенные
 * задачи. Путь утечки назван прямо в коде — `app/api/cron/evo/route.ts`:
 * «kernel-задача останется в 'running' — некому позвать failEvoRunTask».
 * Вместе с индексом 920 (см. K-1) это переходило из «мусора в панели» в
 * «ресурс заблокирован навсегда»: нетерминальная задача держит (capability,
 * ресурс) вечно.
 *
 * Переход — `failed_terminal`, и это осознанный компромисс, а не утверждение
 * о факте. Мы НЕ знаем, исполнился ли эффект: контейнер мог умереть и до, и
 * после него. Знание об этом живёт в `agent_effects` (beginEffect ставится ДО
 * эффекта — именно чтобы повтор не исполнил его дважды), а не в состоянии
 * задачи. Терминальное состояние выбрано потому, что ТОЛЬКО оно освобождает
 * ресурс: предикат индекса 920 исключает succeeded/failed_terminal/cancelled/
 * rejected, и `failed_retryable` ресурс бы не отпустил. В детали перехода
 * уходит `outcome_unknown: true` — чтобы «жнец прибрал» никогда не читалось
 * как «работа провалилась».
 */
export async function reapExpiredLeases(
  actor = 'kernel:lease-reaper',
  limit = 20,
): Promise<ReapedTask[]> {
  const { rows } = await pool.query<{
    id: string; capability: string; resource_type: string | null;
    resource_id: string | null; claimed_by: string | null; lease_until: string;
  }>(
    `SELECT id, capability, resource_type, resource_id, claimed_by, lease_until
     FROM agent_tasks
     WHERE state = 'running'
       AND lease_until IS NOT NULL
       AND lease_until < NOW() - ($1 || ' seconds')::interval
     ORDER BY lease_until ASC
     LIMIT $2`,
    [String(LEASE_REAP_GRACE_SECONDS), limit],
  );

  const reaped: ReapedTask[] = [];
  for (const r of rows) {
    // Переход атомарен по state: если исполнитель завершил задачу между
    // выборкой и этой строкой, from='running' не совпадёт и жнец отступит.
    const res = await transition(r.id, 'running', 'failed_terminal', actor, {
      summary: 'lease истёк — задача брошена',
      reason: 'lease_expired',
      outcome_unknown: true,
      lease_until: r.lease_until,
      claimed_by: r.claimed_by,
      grace_seconds: LEASE_REAP_GRACE_SECONDS,
    });
    if (!res.ok) continue;
    reaped.push({
      id: r.id,
      capability: r.capability,
      resource: r.resource_type && r.resource_id ? `${r.resource_type}:${r.resource_id}` : null,
      claimed_by: r.claimed_by,
    });
  }
  return reaped;
}
