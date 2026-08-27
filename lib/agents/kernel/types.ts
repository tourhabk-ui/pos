/**
 * Volcano OS — Agent Kernel: типы и матрица жизненного цикла задачи.
 *
 * Состояния и допустимые переходы объявлены ДАННЫМИ, а не разбросаны по
 * коду: kernel отклоняет любой переход, которого нет в матрице, и каждая
 * смена состояния оставляет строку в agent_events. Правило то же, что у
 * карты (§12 CLAUDE.md): одно правило в одном месте, сторож держит матрицу.
 *
 * Модель автономии (решение владельца 27.08): человек принимает ровно одно
 * решение — merge/reject подготовленного PR. Операционные действия либо
 * автоматически разрешены явной policy и исполняются, либо автоматически
 * отклоняются со следом. Поэтому операционное решение policy — allow|deny
 * БЕЗ ask: незнакомая capability отклоняется, а не создаёт очередь ручного
 * одобрения. Расширение полномочий — только PR-изменением реестра policy.
 *
 * partial — НЕ состояние задачи, а исход прогона/стадии (details события,
 * summary задачи). Отдельного состояния claimed нет: захват переводит
 * queued → running и фиксирует lease ДО исполнения эффекта тем же UPDATE.
 */

export const TASK_STATES = [
  'proposed',          // создана, полномочия ещё не проверены
  'awaiting_approval', // LEGACY (до модели автономии 27.08): новые задачи сюда не попадают
  'queued',            // policy пропустила, готова к захвату
  'running',           // захвачена (lease зафиксирован) и исполняется
  'awaiting_merge',    // ТОЛЬКО code/policy задачи: PR готов, ждёт merge/reject человека
  'succeeded',         // терминал
  'failed_retryable',  // провал, допускающий повтор — вернётся в queued
  'failed_terminal',   // терминал: провал без повтора
  'cancelled',         // терминал: снята человеком
  'rejected',          // терминал: policy запретила / человек отклонил PR
] as const;

export type TaskState = (typeof TASK_STATES)[number];

/** Терминальные состояния: из них переходов нет. */
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  'succeeded', 'failed_terminal', 'cancelled', 'rejected',
]);

/**
 * Состояния, в которых внешний idempotency_key считается ЗАНЯТЫМ: эффект
 * либо ещё может исполниться, либо уже исполнен. Ровно этот список стоит в
 * предикате уникального индекса миграции 918 — kernel и БД судят одинаково.
 */
export const IDEMPOTENCY_ACTIVE_STATES: readonly TaskState[] = [
  'proposed', 'awaiting_approval', 'queued', 'running', 'awaiting_merge', 'succeeded',
];

/**
 * Матрица переходов. Ключ — откуда, значение — куда можно.
 * Терминальных состояний в ключах нет намеренно: завершённая задача не
 * оживает — follow-up это НОВАЯ задача с parent_task_id.
 * awaiting_merge — только для задач изменения кода/политики (сторож держит
 * это по вызывающим); операционные задачи через него не проходят.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<string, readonly TaskState[]>> = {
  proposed:          ['queued', 'rejected'],
  awaiting_approval: ['queued', 'rejected', 'cancelled'], // legacy-строки, новые не создаются
  queued:            ['running', 'cancelled'],
  running:           ['succeeded', 'awaiting_merge', 'failed_retryable', 'failed_terminal', 'cancelled'],
  // awaiting_merge → running: новый commit в готовый PR снимает readiness —
  // агент снова дорабатывает; label и уведомление вернутся после зелёного CI.
  awaiting_merge:    ['running', 'succeeded', 'rejected', 'cancelled'],
  failed_retryable:  ['queued', 'failed_terminal', 'cancelled'],
};

export function isTransitionAllowed(from: TaskState, to: TaskState): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export type TaskRisk = 'safe' | 'review' | 'forbidden';

/**
 * Операционное решение policy: allow или deny. ask из операционного пути
 * УДАЛЁН (27.08): очередь ручного approval для повседневных действий больше
 * не создаётся — незнакомое отклоняется со следом.
 */
export type PolicyDecision = 'allow' | 'deny';

/**
 * Principal формируется ТОЛЬКО из проверенного контекста — сессии/JWT
 * (operator, admin), CRON_SECRET (cron) или самого кода (system). Никогда
 * из аргументов модели: модель предлагает действие, ядро решает от чьего
 * имени оно идёт.
 */
export interface TrustedPrincipal {
  type: 'operator' | 'admin' | 'cron' | 'system';
  id: string; // partner id / user id / имя крона / имя подсистемы
}

export function principalToString(p: TrustedPrincipal): string {
  return `${p.type}:${p.id}`;
}

/** Контекст решения policy. phase pre_commit читает ТЕКУЩЕЕ состояние ресурса. */
export interface PolicyContext {
  principal: TrustedPrincipal;
  capability: string;
  resource?: { type: string; id: string };
  inputHash?: string;
  taskId?: string;
  phase: 'admission' | 'pre_commit';
}

export interface PolicyVerdict {
  decision: PolicyDecision;
  reason: string;
}

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
  principal: TrustedPrincipal;
  capability: string;           // tour.set_published / initiative.<type> / evo.run
  resource?: { type: string; id: string };
  /** Ключ идемпотентности: у ключа ровно один активный/успешный владелец. */
  idempotencyKey?: string;
  /** Родительская задача (для дочерних шагов) и общий trace. */
  parentTaskId?: string;
  traceId?: string;
  /**
   * Хэш входа. Тот же ключ с другим хэшем — детерминированный конфликт при
   * любом активном/успешном состоянии владельца: одинаковый ключ обязан
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
