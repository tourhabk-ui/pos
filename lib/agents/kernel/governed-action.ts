/**
 * Volcano OS — единственный управляемый путь операционной мутации.
 *
 * executeGovernedAction() проводит эффект через ядро:
 *   admission policy (allow/deny) → атомарное создание задачи с ключом
 *   идемпотентности (ON CONFLICT, не SELECT-до-INSERT) → захват СВОЕЙ
 *   задачи по id (lease ДО эффекта) → pre_commit policy с чтением текущего
 *   состояния ресурса → эффект (вне DB-транзакций) → терминал + события.
 *
 * Контракты (модель автономии 27.08):
 * - deny → задача rejected + событие policy_denied, эффект не исполняется;
 *   очередь ручного approval НЕ создаётся — ask из операционного пути
 *   удалён, ApprovalRequired ядром не импортируется;
 * - тот же idempotencyKey + тот же inputHash + активный владелец → эффект
 *   не запускается, возвращается existing/in-progress;
 * - тот же ключ + тот же hash + succeeded → duplicate:true, без эффекта;
 * - тот же ключ + ДРУГОЙ hash при активном/успешном владельце →
 *   детерминированный конфликт;
 * - провал эффекта → failed_terminal с текстом ошибки; ретраи решает
 *   вызывающий, заводя НОВУЮ задачу (parent_task_id) — тихих повторов нет.
 */

import { createHash } from 'node:crypto';
import {
  appendEvent,
  claimTaskById,
  createTask,
  transition,
} from './kernel';
import { beginEffect, commitEffect, failEffect } from './effects';
import { decidePolicy } from './policy';
import {
  principalToString,
  type GovernedActionInput,
  type GovernedActionResult,
} from './types';

export function hashInput(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');
}

export async function executeGovernedAction<T>(
  input: GovernedActionInput<T>,
): Promise<GovernedActionResult<T>> {
  const actor = principalToString(input.principal);

  // ── Admission policy: allow или deny, без очереди к человеку ───────────
  const admission = await decidePolicy({
    principal: input.principal,
    capability: input.capability,
    resource: input.resource,
    inputHash: input.inputHash,
    phase: 'admission',
  });

  if (admission.decision === 'deny') {
    const denied = await createTask({
      principal: actor,
      capability: input.capability,
      risk: 'forbidden',
      state: 'rejected',
      resource: input.resource,
      // Ключ у rejected-задачи не сохраняется: отказ не должен занимать
      // ключ и блокировать законный вызов с правильными полномочиями.
      parentTaskId: input.parentTaskId,
      traceId: input.traceId,
      inputHash: input.inputHash,
      details: { policy: admission.reason },
    });
    const task = denied.created ? denied.task : denied.existing;
    await appendEvent(task.id, 'kernel', 'policy_denied', { reason: admission.reason, phase: 'admission' });
    return { ok: false, taskId: task.id, traceId: task.trace_id, reason: admission.reason, state: 'rejected' };
  }

  // ── Атомарное создание: у ключа ровно один активный владелец ───────────
  const outcome = await createTask({
    principal: actor,
    capability: input.capability,
    risk: 'safe',
    state: 'queued',
    resource: input.resource,
    idempotencyKey: input.idempotencyKey,
    parentTaskId: input.parentTaskId,
    traceId: input.traceId,
    inputHash: input.inputHash,
  });

  if (!outcome.created) {
    const owner = outcome.existing;
    const sameInput = !input.inputHash || !owner.input_hash || owner.input_hash === input.inputHash;
    if (!sameInput) {
      return {
        ok: false,
        taskId: owner.id,
        traceId: owner.trace_id,
        reason: `конфликт идемпотентности: ключ '${input.idempotencyKey}' занят задачей с другим входом`,
        state: owner.state,
      };
    }
    if (owner.state === 'succeeded') {
      await appendEvent(owner.id, actor, 'note', {
        duplicate_call: true,
        reason: 'повтор с тем же ключом идемпотентности — эффект не исполнялся',
      });
      return { ok: true, taskId: owner.id, traceId: owner.trace_id, result: null, duplicate: true };
    }
    // Активный владелец: конкурент уже исполняет это действие.
    return {
      ok: false,
      taskId: owner.id,
      traceId: owner.trace_id,
      reason: `действие с этим ключом уже исполняется (задача в состоянии ${owner.state})`,
      state: owner.state,
    };
  }

  const task = outcome.task;

  // ── Захват СВОЕЙ задачи по id: lease фиксируется ДО эффекта ────────────
  const claimed = await claimTaskById(task.id, actor);
  if (!claimed) {
    return {
      ok: false,
      taskId: task.id,
      traceId: task.trace_id,
      reason: 'захват не удался: задача уже не в очереди (снята или взята параллельно)',
      state: task.state,
    };
  }

  // ── Pre-commit policy: то же решение, но по ТЕКУЩЕМУ состоянию ─────────
  const precommit = await decidePolicy({
    principal: input.principal,
    capability: input.capability,
    resource: input.resource,
    inputHash: input.inputHash,
    taskId: claimed.id,
    phase: 'pre_commit',
  });
  if (precommit.decision === 'deny') {
    await appendEvent(claimed.id, 'kernel', 'policy_denied', { reason: precommit.reason, phase: 'pre_commit' });
    await transition(claimed.id, 'running', 'failed_terminal', 'kernel', {
      summary: `policy отклонила перед commit: ${precommit.reason}`,
    });
    return {
      ok: false,
      taskId: claimed.id,
      traceId: claimed.trace_id,
      reason: precommit.reason,
      state: 'failed_terminal',
    };
  }

  await appendEvent(claimed.id, actor, 'effect_started', {
    capability: claimed.capability,
    resource: input.resource ?? null,
  });
  // Durable intent ДО вызова эффекта (P3, 922): один governed-эффект на
  // задачу в этом общем пути — claimTaskById уже гарантирует, что задача
  // захватывается ровно один раз, поэтому effectKey = id задачи.
  const beginResult = await beginEffect(claimed.id, claimed.id, {
    capability: claimed.capability,
    resource: input.resource ?? null,
  });

  // Эффект — вне любых DB-транзакций ядра.
  try {
    const result = await input.execute();
    if (beginResult.outcome === 'started') {
      await commitEffect(beginResult.effect.id, input.idempotencyKey ?? null);
    }
    await appendEvent(claimed.id, actor, 'effect_committed', {
      delivery_key: input.idempotencyKey ?? null,
    });
    const summary = input.summarize ? input.summarize(result) : null;
    const done = await transition(claimed.id, 'running', 'succeeded', actor, {
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
    if (beginResult.outcome === 'started') {
      await failEffect(beginResult.effect.id, msg);
    }
    await transition(claimed.id, 'running', 'failed_terminal', actor, {
      summary: `эффект провален: ${msg}`,
    });
    return { ok: false, taskId: claimed.id, traceId: claimed.trace_id, reason: msg, state: 'failed_terminal' };
  }
}
