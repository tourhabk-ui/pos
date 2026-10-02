/**
 * Разбор сообщения JSON-RPC 2.0 для публичного MCP (проверка 29.09).
 *
 * Роут до этого деструктурировал тело как объект и отвечал по полю `method`:
 *   - любое уведомление, кроме notifications/initialized (cancelled, которое
 *     SDK шлёт при таймауте; roots/list_changed), и ответ клиента получали
 *     HTTP 400 с телом-ошибкой — а на уведомление JSON-RPC не отвечает вовсе,
 *     Streamable HTTP принимает его пустым 202;
 *   - пакет (массив) читался как «Method not found: undefined», хотя ревизия
 *     2025-03-26, которую мы объявляем, требует пакеты принимать;
 *   - тело `null` роняло роут необработанным TypeError до try.
 * Разбор отдельной чистой функцией: у каждого случая свой исход, и сторож
 * проверяет их без HTTP.
 */

export type JsonRpcId = string | number | null;

export type McpMessage =
  | { kind: 'request'; id: JsonRpcId; method: string; params: Record<string, unknown> }
  | { kind: 'notification'; method: string }
  | { kind: 'response' }
  | { kind: 'invalid'; id: JsonRpcId; reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asId(v: unknown): JsonRpcId | undefined {
  if (typeof v === 'string' || v === null) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}

export function classifyMessage(msg: unknown): McpMessage {
  if (!isRecord(msg)) return { kind: 'invalid', id: null, reason: 'Сообщение JSON-RPC должно быть объектом' };
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
  const id = hasId ? asId(msg.id) : undefined;
  if (hasId && id === undefined) return { kind: 'invalid', id: null, reason: 'id должен быть строкой, числом или null' };
  if (msg.jsonrpc !== '2.0') return { kind: 'invalid', id: id ?? null, reason: 'Нужно jsonrpc: "2.0"' };

  // Ответ клиента на запрос сервера. Мы запросов клиенту не шлём, но принять
  // его обязаны молча — 202, как уведомление.
  if (msg.method === undefined && ('result' in msg || 'error' in msg)) return { kind: 'response' };

  if (typeof msg.method !== 'string' || msg.method === '') {
    return { kind: 'invalid', id: id ?? null, reason: 'method должен быть непустой строкой' };
  }
  if (msg.params !== undefined && !isRecord(msg.params)) {
    // Позиционные параметры MCP не использует; на уведомление всё равно не отвечаем.
    if (!hasId) return { kind: 'notification', method: msg.method };
    return { kind: 'invalid', id: id ?? null, reason: 'params должен быть объектом' };
  }
  if (!hasId) return { kind: 'notification', method: msg.method };
  return { kind: 'request', id: id ?? null, method: msg.method, params: (msg.params as Record<string, unknown> | undefined) ?? {} };
}

export function jsonrpcSuccess(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result };
}

export function jsonrpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0' as const, id, error: data === undefined ? { code, message } : { code, message, data } };
}

/**
 * Ошибка, текст которой написан для агента: неверные аргументы, отказ
 * сторожа записи, «тур не прочитался». Всё прочее (отказ пула, чужой
 * TypeError) наружу уходит общим текстом, а подробность — в лог: до 29.09
 * анонимный клиент получал err.message как есть, вплоть до адреса базы.
 */
export class McpUserError extends Error {
  /** Машинный код причины для журнала (миграция 1143): no_consent, bad_phone, … */
  readonly code: string;
  constructor(message: string, code: string = 'refused') {
    super(message);
    this.code = code;
  }
}

export const MCP_INTERNAL_ERROR_TEXT = 'Внутренняя ошибка сервера — повторите позже.';
