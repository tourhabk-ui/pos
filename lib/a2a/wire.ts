/**
 * A2A (Agent2Agent) — проводной слой: версия протокола, имена операций,
 * ошибки и кодек Task/Message в обе стороны.
 *
 * ── Зачем второй протокол рядом с MCP (решение владельца 12.10) ──────────
 *
 * «MCP не всегда доступен агентам: некоторые из песочницы не могут
 * подсоединиться, нужно охватить как можно больше агентов и чатов». MCP даёт
 * агенту набор функций; A2A даёт агенту собеседника: задачу можно прислать
 * текстом, а ответом приходит Task с состоянием. Фреймворки агентов (ADK,
 * LangGraph, Semantic Kernel, CrewAI) умеют A2A-клиента без MCP, а один POST с
 * JSON-ответом проходит через прокси, которые режут SSE Streamable HTTP.
 * Отсутствие сети у агента ни тот ни другой протокол не лечат.
 *
 * ── Версии ────────────────────────────────────────────────────────────────
 *
 * Спецификация 1.0 (Linux Foundation): клиент называет версию заголовком
 * `A2A-Version: Major.Minor`; пустое значение читается как 0.3. Имена
 * операций в 1.0 — `SendMessage`, `GetTask`…; в 0.3 — `message/send`,
 * `tasks/get`…; формы Part, роли и состояния тоже разошлись («kind» ушёл,
 * тип задаёт имя члена; `completed` стало `TASK_STATE_COMPLETED`). Клиентов
 * 0.3 в поле больше, чем 1.0, а цель — охват, поэтому принимаются оба
 * именования, а ответ кодируется той версией, которую назвал клиент.
 * Неподдерживаемая версия — VersionNotSupportedError (-32009), как велит
 * спецификация.
 *
 * Сторож: tests/unit/a2a-wire.test.ts.
 */

export type A2AVersion = '0.3' | '1.0';

export const A2A_SUPPORTED_VERSIONS: readonly A2AVersion[] = ['1.0', '0.3'];

/** HTTP-заголовок (и query-параметр) версии по спецификации 1.0. */
export const A2A_VERSION_HEADER = 'A2A-Version';

export type VersionRead =
  | { ok: true; version: A2AVersion; declared: boolean }
  | { ok: false; requested: string };

/**
 * Версия из заголовка. Пустая — 0.3 (так велит спецификация, и так ведут
 * себя клиенты 0.3, которые заголовка не знают). 0.2 читается как 0.3: у них
 * один проводной формат. Patch-номер не учитывается.
 */
export function readVersion(raw: string | null | undefined): VersionRead {
  const v = (raw ?? '').trim();
  if (v === '') return { ok: true, version: '0.3', declared: false };
  const m = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(v);
  if (!m) return { ok: false, requested: v.slice(0, 20) };
  const majorMinor = `${m[1]}.${m[2]}`;
  if (majorMinor === '1.0') return { ok: true, version: '1.0', declared: true };
  if (majorMinor === '0.3' || majorMinor === '0.2') return { ok: true, version: '0.3', declared: true };
  return { ok: false, requested: v.slice(0, 20) };
}

// ── Операции ──────────────────────────────────────────────────────────────

export type A2AOperation =
  | 'SendMessage'
  | 'SendStreamingMessage'
  | 'GetTask'
  | 'ListTasks'
  | 'CancelTask'
  | 'SubscribeToTask'
  | 'CreateTaskPushNotificationConfig'
  | 'GetTaskPushNotificationConfig'
  | 'ListTaskPushNotificationConfigs'
  | 'DeleteTaskPushNotificationConfig'
  | 'GetExtendedAgentCard';

/** Имя метода JSON-RPC → операция: 1.0 (PascalCase) и 0.3 (путь через «/»). */
const METHOD_NAMES: Record<string, A2AOperation> = {
  SendMessage: 'SendMessage',
  'message/send': 'SendMessage',
  SendStreamingMessage: 'SendStreamingMessage',
  'message/stream': 'SendStreamingMessage',
  GetTask: 'GetTask',
  'tasks/get': 'GetTask',
  ListTasks: 'ListTasks',
  'tasks/list': 'ListTasks',
  CancelTask: 'CancelTask',
  'tasks/cancel': 'CancelTask',
  SubscribeToTask: 'SubscribeToTask',
  'tasks/subscribe': 'SubscribeToTask',
  'tasks/resubscribe': 'SubscribeToTask',
  CreateTaskPushNotificationConfig: 'CreateTaskPushNotificationConfig',
  'tasks/pushNotificationConfig/set': 'CreateTaskPushNotificationConfig',
  'tasks/pushNotificationConfig/create': 'CreateTaskPushNotificationConfig',
  GetTaskPushNotificationConfig: 'GetTaskPushNotificationConfig',
  'tasks/pushNotificationConfig/get': 'GetTaskPushNotificationConfig',
  ListTaskPushNotificationConfigs: 'ListTaskPushNotificationConfigs',
  'tasks/pushNotificationConfig/list': 'ListTaskPushNotificationConfigs',
  DeleteTaskPushNotificationConfig: 'DeleteTaskPushNotificationConfig',
  'tasks/pushNotificationConfig/delete': 'DeleteTaskPushNotificationConfig',
  GetExtendedAgentCard: 'GetExtendedAgentCard',
  'agent/getAuthenticatedExtendedCard': 'GetExtendedAgentCard',
  'agent/authenticatedExtendedCard': 'GetExtendedAgentCard',
};

export function readOperation(method: string): A2AOperation | null {
  return Object.prototype.hasOwnProperty.call(METHOD_NAMES, method) ? METHOD_NAMES[method] : null;
}

/** Все имена, которые принимает сервер, — для карточки и сторожа. */
export const A2A_METHOD_NAMES: readonly string[] = Object.keys(METHOD_NAMES);

/**
 * Методы MCP: с ними на адрес A2A приходит MCP-клиент (13.10 MethodNotFound
 * получил BrickBlueBot — клиент нашего MCP). Ответ тот же, но с адресом MCP.
 */
export const MCP_METHOD_NAMES: ReadonlySet<string> = new Set([
  'initialize', 'ping', 'tools/list', 'tools/call', 'resources/list', 'resources/read', 'prompts/list', 'prompts/get',
]);

// ── Ошибки ────────────────────────────────────────────────────────────────

/**
 * Коды A2A 1.0 (раздел 5.4 спецификации): JSON-RPC, HTTP-статус, статус
 * google.rpc для REST-биндинга и причина для ErrorInfo. Стандартные коды
 * JSON-RPC — рядом, чтобы у REST-биндинга был один словарь.
 */
export const A2A_ERROR = {
  TaskNotFound:                   { code: -32001, name: 'TaskNotFoundError',                  http: 404, status: 'NOT_FOUND',           reason: 'TASK_NOT_FOUND' },
  TaskNotCancelable:              { code: -32002, name: 'TaskNotCancelableError',             http: 400, status: 'FAILED_PRECONDITION', reason: 'TASK_NOT_CANCELABLE' },
  PushNotificationNotSupported:   { code: -32003, name: 'PushNotificationNotSupportedError',  http: 400, status: 'FAILED_PRECONDITION', reason: 'PUSH_NOTIFICATION_NOT_SUPPORTED' },
  UnsupportedOperation:           { code: -32004, name: 'UnsupportedOperationError',          http: 400, status: 'FAILED_PRECONDITION', reason: 'UNSUPPORTED_OPERATION' },
  ContentTypeNotSupported:        { code: -32005, name: 'ContentTypeNotSupportedError',       http: 400, status: 'INVALID_ARGUMENT',    reason: 'CONTENT_TYPE_NOT_SUPPORTED' },
  InvalidAgentResponse:           { code: -32006, name: 'InvalidAgentResponseError',          http: 500, status: 'INTERNAL',            reason: 'INVALID_AGENT_RESPONSE' },
  ExtendedAgentCardNotConfigured: { code: -32007, name: 'ExtendedAgentCardNotConfiguredError', http: 400, status: 'FAILED_PRECONDITION', reason: 'EXTENDED_AGENT_CARD_NOT_CONFIGURED' },
  ExtensionSupportRequired:       { code: -32008, name: 'ExtensionSupportRequiredError',      http: 400, status: 'FAILED_PRECONDITION', reason: 'EXTENSION_SUPPORT_REQUIRED' },
  VersionNotSupported:            { code: -32009, name: 'VersionNotSupportedError',           http: 400, status: 'FAILED_PRECONDITION', reason: 'VERSION_NOT_SUPPORTED' },
  ParseError:                     { code: -32700, name: 'ParseError',                         http: 400, status: 'INVALID_ARGUMENT',    reason: 'PARSE_ERROR' },
  InvalidRequest:                 { code: -32600, name: 'InvalidRequest',                     http: 400, status: 'INVALID_ARGUMENT',    reason: 'INVALID_REQUEST' },
  MethodNotFound:                 { code: -32601, name: 'MethodNotFound',                     http: 404, status: 'NOT_FOUND',           reason: 'METHOD_NOT_FOUND' },
  InvalidParams:                  { code: -32602, name: 'InvalidParams',                      http: 400, status: 'INVALID_ARGUMENT',    reason: 'INVALID_PARAMS' },
  Internal:                       { code: -32603, name: 'InternalError',                      http: 500, status: 'INTERNAL',            reason: 'INTERNAL' },
} as const;

export type A2AErrorKind = keyof typeof A2A_ERROR;

export interface A2AError {
  kind: A2AErrorKind;
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

export function a2aError(kind: A2AErrorKind, message: string, data?: Record<string, unknown>): A2AError {
  return { kind, code: A2A_ERROR[kind].code, message, ...(data ? { data } : {}) };
}

/**
 * Тело ошибки REST-биндинга (раздел 11.6): google.rpc.Status с ErrorInfo,
 * `code` — HTTP-статус числом, `status` — строка статуса, `reason` — A2A.
 */
export function httpErrorBody(err: A2AError, now: () => number = Date.now): { status: number; body: Record<string, unknown> } {
  const def = A2A_ERROR[err.kind];
  return {
    status: def.http,
    body: {
      error: {
        code: def.http,
        status: def.status,
        message: err.message,
        details: [{
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: def.reason,
          domain: 'a2a-protocol.org',
          metadata: { ...(err.data ?? {}), timestamp: new Date(now()).toISOString() },
        }],
      },
    },
  };
}

// ── Модель задачи (внутренняя, независимая от версии) ─────────────────────

export type TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'auth-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected';

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(['completed', 'failed', 'canceled', 'rejected']);

export type OutPart = { text: string } | { data: Record<string, unknown> };

export interface OutMessage {
  messageId: string;
  role: 'user' | 'agent';
  parts: OutPart[];
  contextId: string;
  taskId: string;
}

export interface TaskArtifact {
  artifactId: string;
  name: string;
  parts: OutPart[];
}

export interface TaskRecord {
  id: string;
  contextId: string;
  state: TaskState;
  /** Сообщение агента в статусе: причина отказа/сбоя или краткий ответ. */
  statusMessage: OutMessage | null;
  timestamp: string;
  artifacts: TaskArtifact[];
  history: OutMessage[];
  metadata: Record<string, unknown>;
}

// ── Кодирование наружу ────────────────────────────────────────────────────

function encodePart(p: OutPart, v: A2AVersion): Record<string, unknown> {
  if ('text' in p) return v === '1.0' ? { text: p.text } : { kind: 'text', text: p.text };
  return v === '1.0' ? { data: p.data } : { kind: 'data', data: p.data };
}

export function encodeMessage(m: OutMessage, v: A2AVersion): Record<string, unknown> {
  const parts = m.parts.map((p) => encodePart(p, v));
  if (v === '1.0') {
    return { messageId: m.messageId, role: m.role === 'user' ? 'ROLE_USER' : 'ROLE_AGENT', parts, contextId: m.contextId, taskId: m.taskId };
  }
  return { kind: 'message', messageId: m.messageId, role: m.role, parts, contextId: m.contextId, taskId: m.taskId };
}

export function encodeState(s: TaskState, v: A2AVersion): string {
  return v === '1.0' ? `TASK_STATE_${s.toUpperCase().replace(/-/g, '_')}` : s;
}

/**
 * Task наружу. `historyLength` — сколько последних сообщений истории отдать
 * (null — все). Для 0.3 добавляется дискриминатор `kind`.
 */
export function encodeTask(t: TaskRecord, v: A2AVersion, historyLength: number | null = null): Record<string, unknown> {
  const history = historyLength === null ? t.history : (historyLength <= 0 ? [] : t.history.slice(-historyLength));
  const status: Record<string, unknown> = { state: encodeState(t.state, v), timestamp: t.timestamp };
  if (t.statusMessage) status.message = encodeMessage(t.statusMessage, v);
  const task: Record<string, unknown> = {
    id: t.id,
    contextId: t.contextId,
    status,
    artifacts: t.artifacts.map((a) => ({ artifactId: a.artifactId, name: a.name, parts: a.parts.map((p) => encodePart(p, v)) })),
    history: history.map((m) => encodeMessage(m, v)),
  };
  if (Object.keys(t.metadata).length > 0) task.metadata = t.metadata;
  return v === '1.0' ? task : { kind: 'task', ...task };
}

/** Результат SendMessage: в 1.0 — обёртка oneof `{ task }`, в 0.3 — Task как есть. */
export function encodeSendMessageResult(t: TaskRecord, v: A2AVersion, historyLength: number | null = null): Record<string, unknown> {
  const task = encodeTask(t, v, historyLength);
  return v === '1.0' ? { task } : task;
}

// ── Чтение входящего ──────────────────────────────────────────────────────

export type InboundPart =
  | { kind: 'text'; text: string }
  | { kind: 'data'; data: Record<string, unknown> }
  | { kind: 'file' }
  | { kind: 'unknown' };

export interface InboundMessage {
  messageId: string | null;
  contextId: string | null;
  taskId: string | null;
  parts: InboundPart[];
}

export interface SendMessageParams {
  message: InboundMessage;
  /** `configuration.historyLength`, если клиент его назвал. */
  historyLength: number | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function optionalString(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null;
}

/** Part обеих версий: `{text}` / `{kind:'text', text}`, `{data}` / `{kind:'data', data}`, файл. */
export function readPart(raw: unknown): InboundPart {
  if (!isRecord(raw)) return { kind: 'unknown' };
  if (typeof raw.text === 'string') return { kind: 'text', text: raw.text };
  if (isRecord(raw.data)) return { kind: 'data', data: raw.data };
  if ('file' in raw || raw.kind === 'file') return { kind: 'file' };
  return { kind: 'unknown' };
}

export const MAX_PARTS = 16;
export const MAX_TEXT_CHARS = 8000;

export function readSendMessageParams(params: unknown): { ok: true; params: SendMessageParams } | { ok: false; reason: string } {
  if (!isRecord(params)) return { ok: false, reason: 'params должен быть объектом с полем message' };
  const message = params.message;
  if (!isRecord(message)) return { ok: false, reason: 'Нужно поле message (объект Message с parts)' };
  if (!Array.isArray(message.parts) || message.parts.length === 0) {
    return { ok: false, reason: 'message.parts должен быть непустым массивом Part' };
  }
  if (message.parts.length > MAX_PARTS) return { ok: false, reason: `Не больше ${MAX_PARTS} частей в сообщении` };
  const parts = message.parts.map(readPart);
  for (const p of parts) {
    if (p.kind === 'text' && p.text.length > MAX_TEXT_CHARS) {
      return { ok: false, reason: `Текст длиннее ${MAX_TEXT_CHARS} символов` };
    }
  }
  const configuration = isRecord(params.configuration) ? params.configuration : null;
  const hl = configuration?.historyLength;
  const historyLength = typeof hl === 'number' && Number.isFinite(hl) ? Math.max(0, Math.floor(hl)) : null;
  return {
    ok: true,
    params: {
      message: {
        messageId: optionalString(message.messageId, 128),
        contextId: optionalString(message.contextId, 128),
        taskId: optionalString(message.taskId, 128),
        parts,
      },
      historyLength,
    },
  };
}

/** Параметры GetTask / CancelTask: `{ id }` (0.3 и 1.0), `historyLength` у GetTask. */
export function readTaskIdParams(params: unknown): { ok: true; id: string; historyLength: number | null } | { ok: false; reason: string } {
  if (!isRecord(params)) return { ok: false, reason: 'params должен быть объектом с полем id' };
  const id = optionalString(params.id, 128);
  if (!id) return { ok: false, reason: 'Нужно поле id — идентификатор задачи' };
  const hl = params.historyLength;
  const historyLength = typeof hl === 'number' && Number.isFinite(hl) ? Math.max(0, Math.floor(hl)) : null;
  return { ok: true, id, historyLength };
}
