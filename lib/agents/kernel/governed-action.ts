/**
 * Agent Kernel v1 — единственный управляемый путь мутации.
 *
 * executeGovernedAction() проводит эффект через ядро:
 *   policy (allow/ask/deny) → идемпотентность → задача queued → атомарный
 *   захват (lease ДО эффекта) → ПОВТОРНАЯ проверка policy перед commit →
 *   эффект (вне DB-транзакций) → терминальный переход + события.
 *
 * Контракты:
 * - deny → задача rejected + событие policy_denied, эффект не исполняется;
 * - ask  → задача awaiting_approval + pending-запись в agent_approvals
 *   (ApprovalRequired — адаптер хранения одобрения, не решатель);
 * - тот же idempotencyKey после успеха → duplicate:true, эффект не
 *   повторяется; тот же ключ с ДРУГИМ inputHash → конфликт, не старый
 *   результат: одинаковый ключ обязан значить одинаковое действие;
 * - провал эффекта → failed_terminal с текстом ошибки; ретраи в v1 решает
 *   вызывающий, заводя НОВУЮ задачу (parent_task_id) — тихих повторов нет.
 */

import { createHash } from 'node:crypto';
import { approvalRequired } from '@/lib/agents/safeguards/approval-required';
import {
  appendEvent,
  claimTask,
  createTask,
  findByIdempotencyKey,
  transition,
} from './kernel';
import { decideCapability } from './policy';
import type { GovernedActionInput, GovernedActionResult } from './types';

export function hashInput(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');
}

export async function executeGovernedAction<T>(
  input: GovernedActionInput<T>,
): Promise<GovernedActionResult<T>> {
  const policy = decideCapability(input.capability);

  // ── Идемпотентность: до создания задачи ────────────────────────────────
  if (input.idempotencyKey) {
    const prior = await findByIdempotencyKey(input.idempotencyKey);
    if (prior && prior.state === 'succeeded') {
      if (input.inputHash && prior.input_hash && prior.input_hash !== input.inputHash) {
        return {
          ok: false,
          taskId: prior.id,
          traceId: prior.trace_id,
          reason: `конфликт идемпотентности: ключ '${input.idempotencyKey}' уже исполнен с другим входом`,
          state: prior.state,
        };
      }
      await appendEvent(prior.id, input.principal, 'note', {
        duplicate_call: true,
        reason: 'повтор с тем же ключом идемпотентности — эффект не исполнялся',
      });
      return { ok: true, taskId: prior.id, traceId: prior.trace_id, result: null, duplicate: true };
    }
  }

  // ── deny ───────────────────────────────────────────────────────────────
  if (policy.decision === 'deny') {
    const task = await createTask({
      principal: input.principal,
      capability: input.capability,
      risk: policy.risk,
      state: 'rejected',
      resource: input.resource,
      idempotencyKey: input.idempotencyKey,
      parentTaskId: input.parentTaskId,
      traceId: input.traceId,
      inputHash: input.inputHash,
      details: { policy: policy.reason },
    });
    await appendEvent(task.id, 'kernel', 'policy_denied', { reason: policy.reason });
    return { ok: false, taskId: task.id, traceId: task.trace_id, reason: policy.reason, state: 'rejected' };
  }

  // ── ask: задача ждёт человека, адаптер хранения — ApprovalRequired ─────
  if (policy.decision === 'ask') {
    const approval = await approvalRequired.request({
      type: input.capability,
      description: `Kernel: ${input.capability} от ${input.principal}`,
      context: {
        resource: input.resource ?? null,
        idempotency_key: input.idempotencyKey ?? null,
        input_hash: input.inputHash ?? null,
      },
      requested_by: input.principal,
    });
    const task = await createTask({
      principal: input.principal,
      capability: input.capability,
      risk: policy.risk,
      state: 'awaiting_approval',
      resource: input.resource,
      idempotencyKey: input.idempotencyKey,
      parentTaskId: input.parentTaskId,
      traceId: input.traceId,
      inputHash: input.inputHash,
      approvalId: approval.id,
      details: { policy: policy.reason, approval_id: approval.id ?? null },
    });
    return {
      ok: false,
      taskId: task.id,
      traceId: task.trace_id,
      reason: `требуется одобрение человека: ${policy.reason}`,
      state: 'awaiting_approval',
    };
  }

  // ── allow: queued → атомарный захват → эффект ──────────────────────────
  const task = await createTask({
    principal: input.principal,
    capability: input.capability,
    risk: policy.risk,
    state: 'queued',
    resource: input.resource,
    idempotencyKey: input.idempotencyKey,
    parentTaskId: input.parentTaskId,
    traceId: input.traceId,
    inputHash: input.inputHash,
  });

  // Захват фиксирует lease ДО эффекта. Захватываем именно свою задачу:
  // claim берёт старейшую queued этой capability — при конкуренции чужая
  // задача уйдёт другому исполнителю, своя дождётся; для inline-пути
  // (создали и тут же исполняем) это эквивалентно захвату своей.
  const claimed = await claimTask(input.capability, input.principal);
  if (!claimed) {
    return {
      ok: false,
      taskId: task.id,
      traceId: task.trace_id,
      reason: 'захват не удался: очередь пуста (задачу забрал параллельный исполнитель)',
      state: 'queued',
    };
  }

  // Повторная проверка policy НЕПОСРЕДСТВЕННО перед эффектом: между первым
  // решением и захватом состояние могло устареть (реестр — код, но правило
  // ядра обязано выполняться и когда policy станет stateful).
  const recheck = decideCapability(claimed.capability);
  if (recheck.decision !== 'allow') {
    await transition(claimed.id, 'running', 'failed_terminal', 'kernel', {
      summary: `policy отозвала разрешение перед commit: ${recheck.reason}`,
    });
    return {
      ok: false,
      taskId: claimed.id,
      traceId: claimed.trace_id,
      reason: `policy отозвала разрешение перед commit: ${recheck.reason}`,
      state: 'failed_terminal',
    };
  }

  await appendEvent(claimed.id, input.principal, 'effect_started', {
    capability: claimed.capability,
    resource: input.resource ?? null,
  });

  // Эффект — вне любых DB-транзакций ядра.
  try {
    const result = await input.execute();
    await appendEvent(claimed.id, input.principal, 'effect_committed', {
      delivery_key: input.idempotencyKey ?? null,
    });
    const summary = input.summarize ? input.summarize(result) : null;
    const done = await transition(claimed.id, 'running', 'succeeded', input.principal, {
      ...(summary ? { summary } : {}),
    });
    if (!done.ok) {
      // Эффект прошёл, терминальная запись — нет: это НЕ успех ядра, и
      // молчать нельзя (§4.0). Вызывающий видит правду и решает сам.
      return {
        ok: false,
        taskId: claimed.id,
        traceId: claimed.trace_id,
        reason: `эффект исполнен, но терминальный переход не записан: ${done.reason}`,
        state: 'running',
      };
    }
    return { ok: true, taskId: claimed.id, traceId: claimed.trace_id, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await transition(claimed.id, 'running', 'failed_terminal', input.principal, {
      summary: `эффект провален: ${msg}`,
    });
    return { ok: false, taskId: claimed.id, traceId: claimed.trace_id, reason: msg, state: 'failed_terminal' };
  }
}
