/**
 * A2A-агент Ведара, биндинг JSON-RPC 2.0 — https://vedarai.ru/api/a2a
 *
 * Второй протокольный вход рядом с MCP (/api/mcp), решение владельца 12.10:
 * «MCP не всегда доступен агентам, некоторые из песочницы не могут
 * подсоединиться, нужно охватить как можно больше агентов и чатов». Тот же
 * реестр инструментов и тот же мозг Кузьмича, другой язык: агент присылает
 * Message, получает Task. Визитка — /.well-known/agent-card.json (1.0) и
 * /.well-known/agent.json (0.3); REST-биндинг — /api/a2a/v1.
 *
 * Версия — заголовком `A2A-Version` (пусто = 0.3); принимаются имена
 * операций обеих версий (lib/a2a/wire). Ошибки протокола уходят телом
 * JSON-RPC с HTTP 200, как у MCP: клиент SDK на не-2xx бросает транспортную
 * ошибку и не видит кода. Исключения: неподдерживаемая версия (400), тело
 * больше лимита (413), нечитаемый JSON (400).
 *
 * Сторож: tests/unit/a2a-route.test.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { classifyMessage, jsonrpcSuccess, jsonrpcError, MCP_INTERNAL_ERROR_TEXT } from '@/lib/mcp/jsonrpc';
import { MAX_BODY_BYTES, readBodyLimited } from '@/lib/mcp/read-body';
import { handleA2A } from '@/lib/a2a/handle';
import { a2aTaskStore } from '@/lib/a2a/task-store';
import { buildAgentCard } from '@/lib/a2a/agent-card';
import { A2A_ERROR, A2A_METHOD_NAMES, A2A_SUPPORTED_VERSIONS, readOperation } from '@/lib/a2a/wire';
import { logText } from '@/lib/log/log-text';
import { buildExecutors, journalA2a, optionsResponse, publicBase, versionOf, withCors, type JournalFields } from './_shared';

export const dynamic = 'force-dynamic';

/** GET — человеку и curl: визитка, та же, что по well-known адресу. */
export async function GET(request?: NextRequest) {
  // Чтение визитки — тоже «зашёл»: в журнал, как и вызовы (12.10).
  if (request) journalA2a(request, 'jsonrpc', Date.now(), { op: 'card', version: versionOf(request) });
  return withCors(NextResponse.json(buildAgentCard(publicBase()), { headers: { 'Cache-Control': 'public, max-age=3600' } }));
}

export async function OPTIONS() {
  return optionsResponse();
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  const version = versionOf(request);
  // Каждый исход — в журнал A2A, включая отказы до диспетчера.
  const note = (f: Omit<JournalFields, 'version'>) => journalA2a(request, 'jsonrpc', startedAt, { version, ...f });
  if (!version.ok) {
    note({ op: 'invalid', errorCode: 'VersionNotSupported' });
    return withCors(NextResponse.json(
      jsonrpcError(null, A2A_ERROR.VersionNotSupported.code, `Unsupported A2A-Version: ${version.requested}. Supported: ${A2A_SUPPORTED_VERSIONS.join(', ')}`),
      { status: 400 },
    ));
  }

  const raw = await readBodyLimited(request);
  if (raw === null) {
    note({ op: 'invalid', errorCode: 'BodyTooLarge' });
    return withCors(NextResponse.json(jsonrpcError(null, A2A_ERROR.InvalidRequest.code, `Invalid Request: тело больше ${MAX_BODY_BYTES / 1024} КБ`), { status: 413 }));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    note({ op: 'invalid', errorCode: 'ParseError' });
    return withCors(NextResponse.json(jsonrpcError(null, A2A_ERROR.ParseError.code, 'Parse error: тело не JSON'), { status: 400 }));
  }
  if (Array.isArray(parsed)) {
    note({ op: 'invalid', errorCode: 'InvalidRequest' });
    return withCors(NextResponse.json(jsonrpcError(null, A2A_ERROR.InvalidRequest.code, 'Invalid Request: A2A не определяет пакетных запросов — один запрос на POST')));
  }

  const msg = classifyMessage(parsed);
  if (msg.kind === 'invalid') {
    note({ op: 'invalid', errorCode: 'InvalidRequest' });
    return withCors(NextResponse.json(jsonrpcError(msg.id, A2A_ERROR.InvalidRequest.code, `Invalid Request: ${msg.reason}`)));
  }
  // Уведомления и чужие ответы — принять молча, как велит JSON-RPC.
  if (msg.kind === 'notification' || msg.kind === 'response') {
    note({ op: 'notification' });
    return withCors(new NextResponse(null, { status: 202 }));
  }

  const op = readOperation(msg.method);
  if (!op) {
    note({ op: 'invalid', errorCode: 'MethodNotFound' });
    return withCors(NextResponse.json(jsonrpcError(msg.id, A2A_ERROR.MethodNotFound.code, `Method not found: ${msg.method.slice(0, 80)}`, { methods: A2A_METHOD_NAMES })));
  }

  try {
    const out = await handleA2A(op, msg.params, { version: version.version }, { executors: buildExecutors(request), store: a2aTaskStore });
    note({ op, out });
    return withCors(NextResponse.json(out.ok
      ? jsonrpcSuccess(msg.id, out.result)
      : jsonrpcError(msg.id, out.error.code, out.error.message, out.error.data)));
  } catch (err) {
    note({ op, errorCode: 'Internal' });
    // Наружу — общий текст; подробность — в лог (§4.0: отказ не глушится).
    const code = (err as { code?: unknown })?.code;
    console.error('[a2a] операция упала:', op, typeof code === 'string' ? logText(code, 10) : '', logText(err instanceof Error ? err.message : err, 300));
    return withCors(NextResponse.json(jsonrpcError(msg.id, A2A_ERROR.Internal.code, MCP_INTERNAL_ERROR_TEXT)));
  }
}
