/**
 * Agent Kernel v1 — типы и матрица жизненного цикла задачи.
 *
 * Состояния и допустимые переходы объявлены ДАННЫМИ, а не разбросаны по
 * коду: kernel отклоняет любой переход, которого нет в матрице, и каждая
 * смена состояния оставляет строку в agent_events. Правило то же, что у
 * карты (§12 CLAUDE.md): одно правило в одном месте, сторож держит матрицу.
 *
 * Набор состояний согласован с владельцем 27.08: partial — НЕ состояние
 * задачи, а исход прогона/стадии (details события, summary задачи), иначе по
 * задаче не понять, можно ли продолжать или повторять. Отдельного состояния
 * claimed нет: захват (claim) переводит queued → running и фиксирует lease
 * ДО исполнения эффекта — тем же UPDATE.
 */

export const TASK_STATES = [
  'proposed',          // создана, полномочия ещё не проверены
  'awaiting_approval', // policy сказала ask — ждёт человека (agent_approvals)
  'queued',            // policy пропустила, готова к захвату
  'running',           // захвачена (lease зафиксирован) и исполняется
  'succeeded',         // терминал
  'failed_retryable',  // провал, допускающий повтор — вернётся в queued
  'failed_terminal',   // терминал: провал без повтора
  'cancelled',         // терминал: снята человеком
  'rejected',          // терминал: policy запретила / человек отклонил
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/** Терминальные состояния: из них переходов нет. */
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  'succeeded', 'failed_terminal', 'cancelled', 'rejected',
]);

/**
 * Матрица переходов. Ключ — откуда, значение — куда можно.
 * Терминальных состояний в ключах нет намеренно: завершённая задача не
 * оживает — follow-up это НОВАЯ задача с parent_task_id.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<string, readonly TaskState[]>> = {
  proposed:          ['awaiting_approval', 'queued', 'rejected'],
  awaiting_approval: ['queued', 'rejected', 'cancelled'],
  queued:            ['running', 'cancelled'],
  running:           ['succeeded', 'failed_retryable', 'failed_terminal', 'cancelled'],
  failed_retryable:  ['queued', 'failed_terminal', 'cancelled'],
};

export function isTransitionAllowed(from: TaskState, to: TaskState): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export type TaskRisk = 'safe' | 'review' | 'forbidden';

/** Решение policy. Kernel владеет интерфейсом; хранение human approval — адаптер. */
export type PolicyDecision = 'allow' | 'ask' | 'deny';

export interface AgentTask {
  id: string;
  parent_task_id: string | null;
  trace_id: string;
  principal: string;
  capability: string;
  resource_type: string | null;
  resource_id: string | null;
  risk: TaskRisk;
  state: TaskState;
  idempotency_key: string | null;
  input_hash: string | null;
  attempt: number;
  summary: string | null;
}

export interface GovernedActionInput<T> {
  principal: string;            // operator:<id> / admin:<id> / cron:evo
  capability: string;           // tour.set_published / initiative.archive_sos / evo.run
  resource?: { type: string; id: string };
  /** Ключ идемпотентности: тот же ключ после успеха — эффект не повторяется. */
  idempotencyKey?: string;
  /** Родительская задача (для дочерних шагов) и общий trace. */
  parentTaskId?: string;
  traceId?: string;
  /**
   * Хэш входа. Повтор с тем же idempotencyKey, но другим inputHash —
   * КОНФЛИКТ, а не возврат старого результата: одинаковый ключ обязан
   * означать одинаковое действие.
   */
  inputHash?: string;
  /** Сам эффект. Исполняется ровно при state=running, вне DB-транзакций. */
  execute: () => Promise<T>;
  /** Короткий итог для строки задачи (по результату). */
  summarize?: (result: T) => string;
}

export type GovernedActionResult<T> =
  | { ok: true; taskId: string; traceId: string; result: T; duplicate?: false }
  | { ok: true; taskId: string; traceId: string; result: null; duplicate: true }
  | { ok: false; taskId: string | null; traceId: string | null; reason: string; state: TaskState };
