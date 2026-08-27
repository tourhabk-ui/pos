/**
 * Volcano OS — контур инициатив: enqueue и worker.
 *
 * Модель автономии 27.08: человек не подтверждает повседневные действия.
 * Инициатива с capability `initiative.<action_type>` либо разрешена явной
 * строкой реестра policy и исполняется worker'ом автоматически, либо
 * отклоняется со следом (rejected-задача + policy_denied). Generic-safe
 * `initiative.execute` удалён: за одним именем скрывались действия разных
 * классов риска — от Telegram-дайджеста до блокировки пользователей.
 *
 * Payload остаётся в agent_approvals (legacy-хранилище): kernel-задача
 * держит устойчивую ссылку resource=agent_approval:<id>, а worker перед
 * эффектом СВЕРЯЕТ action_type и input_hash — изменившийся контекст не
 * исполняется.
 *
 * Идемпотентность: ключ initiative:<approval_id>. Пока задача активна или
 * успешна — второй enqueue возвращает существующую (двойного исполнения
 * нет по построению БД, миграция 918); после провала ключ свободен, и
 * следующий проход честно заводит новую попытку (ретрай-бюджет держит
 * бухгалтерия agent_approvals: retry_count, статусы done/failed).
 */

import { pool } from '@/lib/db-pool';
import { hashInput } from '../governed-action';
import {
  appendEvent,
  claimNextTask,
  createTask,
  transition,
} from '../kernel';
import { decidePolicy, CAPABILITY_REGISTRY } from '../policy';
import type { TrustedPrincipal } from '../types';

export interface ApprovalPayload {
  id: string;
  action_type: string;
  description: string;
  context: Record<string, unknown>;
  executor_agent_id: string | null;
  executor_name: string | null;
  due_date: string | null;
}

export type EnqueueOutcome =
  | { outcome: 'enqueued'; taskId: string }
  | { outcome: 'already_active'; taskId: string }
  | { outcome: 'already_done'; taskId: string }
  | { outcome: 'rejected'; taskId: string; reason: string };

const WORKER_PRINCIPAL: TrustedPrincipal = { type: 'cron', id: 'kernel-worker' };

export function initiativeCapability(actionType: string): string {
  return `initiative.${actionType}`;
}

export function initiativeInputHash(p: Pick<ApprovalPayload, 'action_type' | 'context'>): string {
  return hashInput({ action_type: p.action_type, context: p.context });
}

/** Разрешённые capabilities инициатив — производная реестра policy. */
export function allowedInitiativeCapabilities(): string[] {
  return Object.keys(CAPABILITY_REGISTRY).filter((c) => c.startsWith('initiative.'));
}

/**
 * Поставить одобренную инициативу в очередь ядра. Идемпотентно: повторный
 * вызов при живой/успешной задаче ничего не создаёт.
 */
export async function enqueueInitiative(
  approval: ApprovalPayload,
  principal: TrustedPrincipal,
): Promise<EnqueueOutcome> {
  const capability = initiativeCapability(approval.action_type);
  const admission = await decidePolicy({ principal, capability, phase: 'admission' });

  if (admission.decision === 'deny') {
    const denied = await createTask({
      principal: `${principal.type}:${principal.id}`,
      capability,
      risk: 'forbidden',
      state: 'rejected',
      resource: { type: 'agent_approval', id: approval.id },
      details: { policy: admission.reason },
    });
    const task = denied.created ? denied.task : denied.existing;
    await appendEvent(task.id, 'kernel', 'policy_denied', { reason: admission.reason, phase: 'admission' });
    // Строка approvals помечается failed с причиной — очередь не копит
    // навечно то, что policy не пропустит никогда.
    await pool.query(
      `UPDATE agent_approvals
       SET execution_status = 'failed', execution_notes = $2, completed_at = NOW()
       WHERE id = $1`,
      [approval.id, JSON.stringify({ rejected_by_policy: admission.reason, kernel_task_id: task.id })],
    ).catch(() => undefined);
    return { outcome: 'rejected', taskId: task.id, reason: admission.reason };
  }

  const created = await createTask({
    principal: `${principal.type}:${principal.id}`,
    capability,
    risk: 'safe',
    state: 'queued',
    resource: { type: 'agent_approval', id: approval.id },
    idempotencyKey: `initiative:${approval.id}`,
    inputHash: initiativeInputHash(approval),
  });
  if (created.created) return { outcome: 'enqueued', taskId: created.task.id };
  return created.existing.state === 'succeeded'
    ? { outcome: 'already_done', taskId: created.existing.id }
    : { outcome: 'already_active', taskId: created.existing.id };
}

/**
 * Sweep: все одобренные ЧЕЛОВЕКОМ и назначенные инициативы — в очередь
 * ядра. Читается без FOR UPDATE намеренно: дедуп держит идемпотентность
 * ядра (ключ initiative:<id>), два конкурентных sweep'а не создадут двух
 * задач по построению.
 */
export async function sweepApprovedInitiatives(
  principal: TrustedPrincipal,
  windowHours = 168,
): Promise<{ scanned: number; outcomes: EnqueueOutcome[] }> {
  const { rows } = await pool.query<ApprovalPayload>(
    `SELECT id, action_type, description, context,
            executor_agent_id, executor_name, due_date
     FROM agent_approvals
     WHERE status = 'approved'
       AND execution_status = 'assigned'
       AND created_at >= NOW() - ($1 || ' hours')::interval
     ORDER BY created_at ASC
     LIMIT 50`,
    [windowHours],
  );
  const outcomes: EnqueueOutcome[] = [];
  for (const row of rows) {
    outcomes.push(await enqueueInitiative(row, principal));
  }
  return { scanned: rows.length, outcomes };
}

export interface WorkerItemResult {
  taskId: string;
  approvalId: string | null;
  capability: string;
  ok: boolean;
  detail: string;
}

/**
 * Дренаж очереди: claimNextTask по каждой разрешённой capability (SKIP
 * LOCKED — два worker'а не возьмут одну задачу), payload из agent_approvals
 * со сверкой хэша, pre_commit policy, эффект ВНЕ транзакций, независимое
 * завершение каждого item.
 */
export async function drainInitiativeQueue(limit = 10): Promise<WorkerItemResult[]> {
  const { executeInitiativeEffect } = await import('@/lib/agents/execution/initiative-executor');
  const results: WorkerItemResult[] = [];

  for (const capability of allowedInitiativeCapabilities()) {
    while (results.length < limit) {
      const task = await claimNextTask(capability, 'cron:kernel-worker', 240);
      if (!task) break;

      const finish = async (ok: boolean, detail: string, terminal: 'succeeded' | 'failed_terminal') => {
        await transition(task.id, 'running', terminal, 'cron:kernel-worker', { summary: detail });
        results.push({ taskId: task.id, approvalId: task.resource_id, capability, ok, detail });
      };

      const approvalId = task.resource_id;
      if (!approvalId) {
        await finish(false, 'у задачи нет ссылки на payload (resource_id пуст)', 'failed_terminal');
        continue;
      }

      const { rows } = await pool.query<ApprovalPayload>(
        `SELECT id, action_type, description, context,
                executor_agent_id, executor_name, due_date
         FROM agent_approvals WHERE id = $1`,
        [approvalId],
      );
      const payload = rows[0];
      if (!payload) {
        await finish(false, `payload agent_approvals ${approvalId} не найден`, 'failed_terminal');
        continue;
      }
      if (initiativeCapability(payload.action_type) !== capability) {
        await finish(false, `action_type '${payload.action_type}' не совпадает с capability задачи`, 'failed_terminal');
        continue;
      }
      if (task.input_hash && initiativeInputHash(payload) !== task.input_hash) {
        await finish(false, 'контекст инициативы изменился после постановки в очередь', 'failed_terminal');
        continue;
      }

      const precommit = await decidePolicy({
        principal: WORKER_PRINCIPAL,
        capability,
        resource: { type: 'agent_approval', id: approvalId },
        taskId: task.id,
        phase: 'pre_commit',
      });
      if (precommit.decision === 'deny') {
        await appendEvent(task.id, 'kernel', 'policy_denied', { reason: precommit.reason, phase: 'pre_commit' });
        await finish(false, `policy отклонила перед эффектом: ${precommit.reason}`, 'failed_terminal');
        continue;
      }

      await appendEvent(task.id, 'cron:kernel-worker', 'effect_started', { approval_id: approvalId });
      try {
        const result = await executeInitiativeEffect({
          approval_id: payload.id,
          executor_agent_id: payload.executor_agent_id ?? 'kernel-worker',
          action_type: payload.action_type,
          description: payload.description,
          context: payload.context ?? {},
          due_date: payload.due_date ?? '',
        });
        await appendEvent(task.id, 'cron:kernel-worker', 'effect_committed', {
          approval_id: approvalId,
          changes: result.changes_made.length,
          errors: result.errors.length,
        });
        if (result.success) {
          await finish(true, `${payload.action_type}: изменений ${result.changes_made.length}`, 'succeeded');
        } else {
          await finish(false, result.errors[0] ?? 'инициатива провалена без описания', 'failed_terminal');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await finish(false, `эффект упал: ${msg}`, 'failed_terminal');
      }
    }
  }
  return results;
}
