/**
 * Запрос эпохи метаданных (MCP 2026-07-28): как его узнать и что сверить
 * до исполнения. Чистые функции — роут (app/api/mcp/route.ts) только
 * переводит исход в HTTP-ответ, а сторож судит правило вызовом.
 *
 * ── Чем modern-запрос отличается ──────────────────────────────────────────
 *
 * Рукопожатия нет: версия и возможности клиента приходят в `_meta` каждого
 * запроса (basic/index, «Per-request protocol fields»), а транспорт
 * зеркалит часть тела в заголовки — `MCP-Protocol-Version`, `Mcp-Method`,
 * `Mcp-Name` (transports/streamable-http, «Request Metadata»). Зеркало
 * нужно посредникам: балансировщик маршрутизирует по заголовку, сервер
 * исполняет по телу, и расхождение между ними — дыра. Поэтому спека велит
 * серверу, читающему тело, сверить одно с другим и отказать при
 * несовпадении (там же, «Server Validation»).
 *
 * ── Порядок проверок и почему он такой ────────────────────────────────────
 *
 *   1. `_meta` без обязательного поля — запрос испорчен: -32602, HTTP 400
 *      (basic/index). Без версии в теле сверять заголовок не с чем.
 *   2. Заголовки: нет обязательного, значение не совпало с телом или
 *      содержит недопустимые знаки — -32020 HeaderMismatch, HTTP 400.
 *      `Mcp-Name` в форме `=?base64?…?=` декодируется ДО сравнения.
 *   3. Версия из `_meta` не из MODERN — -32022 UnsupportedProtocolVersion,
 *      HTTP 400, `data.supported` и `data.requested` (schema.ts).
 * Неизвестный метод (-32601, HTTP 404) решает уже роут: это вопрос не
 * формы запроса, а того, что сервер умеет.
 */

import { isModernProtocolVersion, SUPPORTED_PROTOCOL_VERSIONS } from '@/lib/mcp/protocol-version';

export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

/** Коды из диапазона, который спека 2026-07-28 оставила себе (basic/index, «Error Codes»). */
export const HEADER_MISMATCH = -32020;
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;
export const INVALID_PARAMS = -32602;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function metaOf(message: unknown): Record<string, unknown> | null {
  if (!isRecord(message) || !isRecord(message.params)) return null;
  const meta = message.params._meta;
  return isRecord(meta) ? meta : null;
}

/**
 * Тело говорит на modern: у сообщения (или хоть у одного в пакете) в
 * `params._meta` есть ключ версии. Значение здесь не судится — пустая или
 * чужая версия всё равно modern-запрос, и отказ ему нужен modern-кодом.
 */
export function hasModernMeta(body: unknown): boolean {
  if (Array.isArray(body)) return body.some(hasModernMeta);
  const meta = metaOf(body);
  return meta !== null && Object.prototype.hasOwnProperty.call(meta, META_PROTOCOL_VERSION);
}

const BASE64_PREFIX = '=?base64?';
const BASE64_SUFFIX = '?=';
const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/;
/** Видимый ASCII, пробел и табуляция — RFC 9110, «Field Values». */
const HEADER_SAFE = /^[\t\x20-\x7E]*$/;

/**
 * Значение заголовка `Mcp-Name` → строка для сравнения с телом.
 *
 * Обычное значение — как есть. Форма `=?base64?…?=` (маркеры строчными,
 * ровно так) — UTF-8 из base64. Недопустимые знаки, битый base64 или битый
 * UTF-8 внутри — null: такой заголовок спека велит отвергнуть, а не
 * сравнивать как получится.
 */
export function decodeMcpHeaderValue(value: string): string | null {
  if (!HEADER_SAFE.test(value)) return null;
  if (!(value.startsWith(BASE64_PREFIX) && value.endsWith(BASE64_SUFFIX) && value.length >= BASE64_PREFIX.length + BASE64_SUFFIX.length)) {
    return value;
  }
  const encoded = value.slice(BASE64_PREFIX.length, value.length - BASE64_SUFFIX.length);
  if (encoded.length % 4 !== 0 || !BASE64_BODY.test(encoded)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'base64'));
  } catch {
    // Битый UTF-8 внутри base64 — не имя, а мусор; исход назван вызывающему.
    return null;
  }
}

/** Методы, у которых `Mcp-Name` обязателен, и поле тела, которое он зеркалит. */
const NAME_SOURCE: Readonly<Record<string, 'name' | 'uri'>> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
};

export type ModernCheck =
  | { ok: true; protocolVersion: string; clientInfo: unknown }
  | { ok: false; code: number; message: string; data?: unknown };

function mismatch(message: string): ModernCheck {
  return { ok: false, code: HEADER_MISMATCH, message: `Header mismatch: ${message}` };
}

/** Строка заголовка в сообщение — коротко и без управляющих знаков. */
function quoted(v: string): string {
  return `'${v.replace(/[^\x20-\x7E]/g, '?').slice(0, 80)}'`;
}

/**
 * Сверка modern-запроса до исполнения. `method` и `params` — уже из
 * разобранного JSON-RPC (lib/mcp/jsonrpc.ts, classifyMessage).
 */
export function checkModernRequest(
  headers: Headers,
  method: string,
  params: Record<string, unknown>,
): ModernCheck {
  const meta = isRecord(params._meta) ? params._meta : null;
  const version = meta?.[META_PROTOCOL_VERSION];
  if (typeof version !== 'string' || version === '') {
    return { ok: false, code: INVALID_PARAMS, message: `Invalid params: _meta["${META_PROTOCOL_VERSION}"] обязателен и должен быть строкой` };
  }
  if (!isRecord(meta?.[META_CLIENT_CAPABILITIES])) {
    return { ok: false, code: INVALID_PARAMS, message: `Invalid params: _meta["${META_CLIENT_CAPABILITIES}"] обязателен и должен быть объектом` };
  }

  const headerVersion = headers.get('mcp-protocol-version');
  if (headerVersion === null) return mismatch('нет заголовка MCP-Protocol-Version');
  if (headerVersion !== version) {
    return mismatch(`MCP-Protocol-Version ${quoted(headerVersion)} не совпадает с _meta ${quoted(version)}`);
  }

  const headerMethod = headers.get('mcp-method');
  if (headerMethod === null) return mismatch('нет заголовка Mcp-Method');
  if (!HEADER_SAFE.test(headerMethod) || headerMethod !== method) {
    return mismatch(`Mcp-Method ${quoted(headerMethod)} не совпадает с method ${quoted(method)}`);
  }

  const nameField = NAME_SOURCE[method];
  if (nameField) {
    const bodyName = params[nameField];
    const headerName = headers.get('mcp-name');
    if (headerName === null) {
      // Нет значения и в теле — заголовку нечего зеркалить; отказ за пустое
      // имя дальше даст сам метод.
      if (bodyName !== undefined) return mismatch(`нет заголовка Mcp-Name при params.${nameField} в теле`);
    } else {
      const decoded = decodeMcpHeaderValue(headerName);
      if (decoded === null) return mismatch('Mcp-Name содержит недопустимые знаки или битую base64-форму');
      if (typeof bodyName !== 'string' || decoded !== bodyName) {
        return mismatch(`Mcp-Name ${quoted(decoded)} не совпадает с params.${nameField}`);
      }
    }
  }

  if (!isModernProtocolVersion(version)) {
    return {
      ok: false,
      code: UNSUPPORTED_PROTOCOL_VERSION,
      message: 'Unsupported protocol version',
      data: { supported: [...SUPPORTED_PROTOCOL_VERSIONS], requested: version },
    };
  }
  return { ok: true, protocolVersion: version, clientInfo: meta?.[META_CLIENT_INFO] };
}
