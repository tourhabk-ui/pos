/**
 * Диспетчер операций A2A — чистая логика без HTTP и без базы.
 *
 * Исполнителей два, и оба подставляет роут:
 *  - `runTool` — публичный инструмент тем же путём, что MCP `tools/call`
 *    (runPublicTool в app/api/mcp/route.ts: лимиты, журнал, стражи записи,
 *    ссылка «продолжить в Ведаре»);
 *  - `chat` — свободный текст → ответ Кузьмича (lib/a2a/chat).
 *
 * Исход инструмента переводится в состояние задачи, а не в ошибку протокола:
 * ошибка JSON-RPC — это «ты говоришь не на том языке» (нет такого метода,
 * кривые params), состояние Task — «я тебя понял, и вот что вышло».
 *   ok            → completed, текст инструмента в артефакте
 *   refused       → rejected: агент передал не то (нет согласия, нет мест…)
 *   rate_limited  → rejected: подождите
 *   unknown_tool  → rejected, с живым списком имён в DataPart
 *   failed        → failed: сбой на нашей стороне, не «ничего нет»
 *
 * Чего нет и что сказано вслух: потока (SendStreamingMessage, SubscribeToTask
 * → UnsupportedOperationError), push-уведомлений (→
 * PushNotificationNotSupportedError), списка задач (анонимному клиенту чужие
 * задачи не отдаются → UnsupportedOperationError), расширенной карточки.
 * CancelTask у завершённой задачи — TaskNotCancelableError: задачи здесь
 * рождаются уже завершёнными.
 *
 * Задачи хранятся час и переживают перезапуск (13.10, lib/a2a/durable-store).
 * Хранилище, которое не ответило, — InternalError с этими словами, а не
 * TaskNotFound: «не смог прочитать» и «задачи нет» агенту нужно различать.
 *
 * Сторож: tests/unit/a2a-handle.test.ts.
 */

import { randomUUID } from 'node:crypto';
import type { PublicToolOutcome } from '@/lib/mcp/tool-outcome';
import type { AgentAnswer } from './chat';
import type { A2ATaskStore, ChatTurn, TaskLookup } from './task-store';
import {
  a2aError, encodeSendMessageResult, encodeTask, readSendMessageParams, readTaskIdParams,
  TERMINAL_STATES,
  type A2AError, type A2AOperation, type A2AVersion, type InboundPart, type OutMessage, type OutPart, type TaskRecord, type TaskState,
} from './wire';

export interface A2AExecutors {
  runTool(name: string, args: unknown): Promise<PublicToolOutcome>;
  /** contextId — для журнала общения (lib/a2a/dialog-log): реплики одного разговора связываются его hash. */
  chat(text: string, history: ChatTurn[], contextId: string): Promise<AgentAnswer>;
}

export interface A2AContext {
  version: A2AVersion;
  now?: () => number;
  newId?: () => string;
}

export type A2AResult = { ok: true; result: Record<string, unknown> } | { ok: false; error: A2AError };

/** Форма структурированного вызова в DataPart: {"tool": "...", "arguments": {...}}. */
export interface ToolCallPart {
  tool: string;
  arguments: unknown;
}

export function readToolCall(parts: InboundPart[]): ToolCallPart | null {
  for (const p of parts) {
    if (p.kind === 'data' && typeof p.data.tool === 'string' && p.data.tool.trim() !== '') {
      return { tool: p.data.tool.trim().slice(0, 80), arguments: p.data.arguments ?? {} };
    }
  }
  return null;
}

export function readText(parts: InboundPart[]): string {
  return parts.filter((p): p is Extract<InboundPart, { kind: 'text' }> => p.kind === 'text')
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function agentMessage(ids: () => string, contextId: string, taskId: string, parts: OutPart[]): OutMessage {
  return { messageId: ids(), role: 'agent', parts, contextId, taskId };
}

function makeTask(a: {
  ids: () => string; now: () => number; id: string; contextId: string; state: TaskState;
  text: string; extra?: Record<string, unknown>; artifactName?: string; metadata: Record<string, unknown>;
}): TaskRecord {
  const parts: OutPart[] = [{ text: a.text }];
  if (a.extra) parts.push({ data: a.extra });
  const status = agentMessage(a.ids, a.contextId, a.id, parts);
  return {
    id: a.id,
    contextId: a.contextId,
    state: a.state,
    statusMessage: status,
    timestamp: new Date(a.now()).toISOString(),
    // Артефакт — только у выполненной задачи: отказ и сбой лежат в статусе.
    artifacts: a.state === 'completed' ? [{ artifactId: a.ids(), name: a.artifactName ?? 'answer', parts }] : [],
    history: [status],
    metadata: a.metadata,
  };
}

const EMPTY_MESSAGE = 'В сообщении нет ни текста, ни DataPart с полем tool. Пришлите вопрос TextPart или вызов {"tool": "<имя>", "arguments": {...}}.';
const FILES_NOT_ACCEPTED = 'Файлы не принимаются: только text/plain (вопрос) или application/json (DataPart {"tool", "arguments"}).';

/** Нашлась — задача; нет её — TaskNotFound; хранилище не прочиталось — InternalError, не «нет». */
function lookupResult(lookup: TaskLookup, id: string): { ok: true; task: TaskRecord } | { ok: false; error: A2AError } {
  if (lookup.kind === 'found') return { ok: true, task: lookup.task };
  if (lookup.kind === 'missing') {
    return { ok: false, error: a2aError('TaskNotFound', `Задача ${id} не найдена или старше часа (задачи хранятся час).`, { taskId: id }) };
  }
  return { ok: false, error: a2aError('Internal', `Хранилище задач сейчас не читается — это сбой на стороне Ведара, а не «задачи ${id} нет». Повторите позже.`, { taskId: id }) };
}

type Deps = { executors: A2AExecutors; store: A2ATaskStore };

async function sendMessage(params: unknown, ctx: A2AContext, deps: Deps): Promise<A2AResult> {
  const read = readSendMessageParams(params);
  if (!read.ok) return { ok: false, error: a2aError('InvalidParams', read.reason) };
  const { message, historyLength } = read.params;
  const ids = ctx.newId ?? randomUUID;
  const now = ctx.now ?? Date.now;

  // Продолжение задачи по taskId: наши задачи терминальны с рождения, поэтому
  // продолжать нечего — агенту честно сказано, как начать новую в том же
  // контексте. Неизвестный taskId — TaskNotFound, как у GetTask.
  if (message.taskId) {
    const found = lookupResult(await deps.store.get(message.taskId), message.taskId);
    if (!found.ok) return found;
    const prev = found.task;
    if (TERMINAL_STATES.has(prev.state)) {
      return { ok: false, error: a2aError('InvalidParams', `Задача ${message.taskId} уже завершена (${prev.state}). Отправьте новое сообщение без taskId; contextId можно оставить тот же.`, { taskId: message.taskId, state: prev.state }) };
    }
  }

  const contextId = message.contextId ?? ids();
  const taskId = ids();
  const call = readToolCall(message.parts);

  if (call) {
    const outcome = await deps.executors.runTool(call.tool, call.arguments);
    const metadata = { input: 'tool', tool: call.tool };
    let task: TaskRecord;
    switch (outcome.kind) {
      case 'ok': {
        const extra: Record<string, unknown> = { tool: call.tool };
        if (outcome.handoffUrl) extra.continue_url = outcome.handoffUrl;
        // Инструменты, отдающие JSON (search/fetch), — объектом в DataPart,
        // чтобы агенту не разбирать текст.
        if (outcome.structured) extra.result = outcome.structured;
        task = makeTask({ ids, now, id: taskId, contextId, state: 'completed', text: outcome.text, extra, artifactName: call.tool, metadata });
        break;
      }
      case 'unknown_tool':
        task = makeTask({ ids, now, id: taskId, contextId, state: 'rejected', text: outcome.message, extra: outcome.data, metadata });
        break;
      case 'refused':
      case 'rate_limited':
        task = makeTask({ ids, now, id: taskId, contextId, state: 'rejected', text: outcome.text, metadata });
        break;
      case 'failed':
        task = makeTask({ ids, now, id: taskId, contextId, state: 'failed', text: outcome.text, metadata });
        break;
    }
    await deps.store.put(task);
    return { ok: true, result: encodeSendMessageResult(task, ctx.version, historyLength) };
  }

  const text = readText(message.parts);
  if (!text) {
    const hasFile = message.parts.some((p) => p.kind === 'file');
    return { ok: false, error: a2aError(hasFile ? 'ContentTypeNotSupported' : 'InvalidParams', hasFile ? FILES_NOT_ACCEPTED : EMPTY_MESSAGE) };
  }
  const answer = await deps.executors.chat(text, await deps.store.historyFor(contextId), contextId);
  const metadata = { input: 'text' };
  const task = answer.ok
    ? makeTask({ ids, now, id: taskId, contextId, state: 'completed', text: answer.text, metadata })
    : makeTask({ ids, now, id: taskId, contextId, state: answer.rejected ? 'rejected' : 'failed', text: answer.text, metadata });
  if (answer.ok) await deps.store.remember(contextId, [{ role: 'user', content: text }, { role: 'assistant', content: answer.text }]);
  await deps.store.put(task);
  return { ok: true, result: encodeSendMessageResult(task, ctx.version, historyLength) };
}

export async function handleA2A(
  op: A2AOperation,
  params: unknown,
  ctx: A2AContext,
  deps: Deps,
): Promise<A2AResult> {
  switch (op) {
    case 'SendMessage':
      return sendMessage(params, ctx, deps);
    case 'GetTask': {
      const read = readTaskIdParams(params);
      if (!read.ok) return { ok: false, error: a2aError('InvalidParams', read.reason) };
      const found = lookupResult(await deps.store.get(read.id), read.id);
      if (!found.ok) return found;
      return { ok: true, result: encodeTask(found.task, ctx.version, read.historyLength) };
    }
    case 'CancelTask': {
      const read = readTaskIdParams(params);
      if (!read.ok) return { ok: false, error: a2aError('InvalidParams', read.reason) };
      const found = lookupResult(await deps.store.get(read.id), read.id);
      if (!found.ok) return found;
      const { state } = found.task;
      return { ok: false, error: a2aError('TaskNotCancelable', `Задача ${read.id} уже завершена (${state}): отменять нечего.`, { taskId: read.id, state }) };
    }
    case 'ListTasks':
      return { ok: false, error: a2aError('UnsupportedOperation', 'Список задач анонимному клиенту не отдаётся: задачи читаются по id (GetTask).') };
    case 'SendStreamingMessage':
    case 'SubscribeToTask':
      return { ok: false, error: a2aError('UnsupportedOperation', 'Поток не поддерживается (capabilities.streaming = false): используйте SendMessage — ответ приходит целиком.') };
    case 'CreateTaskPushNotificationConfig':
    case 'GetTaskPushNotificationConfig':
    case 'ListTaskPushNotificationConfigs':
    case 'DeleteTaskPushNotificationConfig':
      return { ok: false, error: a2aError('PushNotificationNotSupported', 'Push-уведомления не поддерживаются (capabilities.pushNotifications = false): задача завершается в ответе на SendMessage.') };
    case 'GetExtendedAgentCard':
      return { ok: false, error: a2aError('UnsupportedOperation', 'Расширенной карточки нет (capabilities.extendedAgentCard = false): всё — в /.well-known/agent-card.json.') };
  }
}
