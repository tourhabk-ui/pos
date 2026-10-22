/**
 * A2A-агент Ведара, биндинг HTTP+JSON (REST) — https://vedarai.ru/api/a2a/v1
 *
 * Пути — по разделу 11 спецификации 1.0: `POST /message:send`,
 * `GET /tasks/{id}`, `POST /tasks/{id}:cancel`; что не поддерживается, отвечает
 * ошибкой google.rpc.Status с ErrorInfo (раздел 11.6), а не молчит. Логика —
 * та же, что у JSON-RPC (lib/a2a/handle); здесь только перевод пути и тела.
 * Двоеточие в сегменте Next отдаёт как есть, поэтому один catch-all вместо
 * папок с двоеточием в имени (на Windows такие имена запрещены).
 *
 * Тип содержимого ответа — application/a2a+json, как рекомендует
 * спецификация; на входе принимается любой JSON.
 *
 * Сторож: tests/unit/a2a-route.test.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { MAX_BODY_BYTES, readBodyLimited } from '@/lib/mcp/read-body';
import { MCP_INTERNAL_ERROR_TEXT } from '@/lib/mcp/jsonrpc';
import { handleA2A } from '@/lib/a2a/handle';
import { a2aTaskStore } from '@/lib/a2a/durable-store';
import { buildAgentCard, A2A_REST_PATH } from '@/lib/a2a/agent-card';
import { a2aError, httpErrorBody, A2A_SUPPORTED_VERSIONS, type A2AError, type A2AOperation, type VersionRead } from '@/lib/a2a/wire';
import { logText } from '@/lib/log/log-text';
import { buildExecutors, CORS_HEADERS, journalA2a, optionsResponse, publicBase, versionOf } from '../../_shared';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ path?: string[] }> };
type VersionOk = Extract<VersionRead, { ok: true }>;

function restError(err: A2AError): NextResponse {
  const { status, body } = httpErrorBody(err);
  return NextResponse.json(body, { status, headers: CORS_HEADERS });
}

function restOk(result: Record<string, unknown>): NextResponse {
  return new NextResponse(JSON.stringify(result), {
    status: 200,
    headers: { 'Content-Type': 'application/a2a+json; charset=utf-8', ...CORS_HEADERS },
  });
}

async function run(request: NextRequest, read: VersionOk, op: A2AOperation, params: unknown, startedAt: number): Promise<NextResponse> {
  try {
    const out = await handleA2A(op, params, { version: read.version }, { executors: buildExecutors(request), store: a2aTaskStore });
    journalA2a(request, 'rest', startedAt, { op, version: read, out });
    return out.ok ? restOk(out.result) : restError(out.error);
  } catch (err) {
    journalA2a(request, 'rest', startedAt, { op, version: read, errorCode: 'Internal' });
    const code = (err as { code?: unknown })?.code;
    console.error('[a2a/rest] операция упала:', op, typeof code === 'string' ? logText(code, 10) : '', logText(err instanceof Error ? err.message : err, 300));
    return restError(a2aError('Internal', MCP_INTERNAL_ERROR_TEXT));
  }
}

async function pathOf(ctx: RouteContext): Promise<string> {
  return ((await ctx.params).path ?? []).join('/');
}

/** Отказ до диспетчера (версия, путь, неподдерживаемая операция) — тоже в журнал. */
function refuse(request: NextRequest, startedAt: number, version: VersionRead, errorCode: string, err: A2AError): NextResponse {
  journalA2a(request, 'rest', startedAt, { op: 'invalid', version, errorCode });
  return restError(err);
}

/**
 * Пути, которые биндинг понимает, — их и называет отказ: агент, постучавший в
 * корень POST-ом (внешняя проверка 22.10), из «нет такого пути» не узнал бы,
 * куда идти.
 */
const REST_PATHS_HINT = 'POST /message:send, GET /tasks/{id}, POST /tasks/{id}:cancel';

/** Пути нет: в журнал — что прислали («ГЛАГОЛ /путь»), агенту — что прислал и какие пути есть. */
function noSuchPath(request: NextRequest, startedAt: number, version: VersionRead, path: string): NextResponse {
  const method = `${request.method} /${path.slice(0, 80)}`;
  journalA2a(request, 'rest', startedAt, { op: 'invalid', version, errorCode: 'MethodNotFound', method });
  return restError(a2aError('MethodNotFound', `Нет такого пути: ${method}. Пути от ${A2A_REST_PATH}: ${REST_PATHS_HINT}`));
}

function versionOr400(request: NextRequest, startedAt: number): { ok: true; read: VersionOk } | { ok: false; res: NextResponse } {
  const v = versionOf(request);
  if (v.ok) return { ok: true, read: v };
  return { ok: false, res: refuse(request, startedAt, v, 'VersionNotSupported', a2aError('VersionNotSupported', `Unsupported A2A-Version: ${v.requested}. Supported: ${A2A_SUPPORTED_VERSIONS.join(', ')}`)) };
}

const TASK_CANCEL = /^tasks\/([^/:]+):cancel$/;
const TASK_SUBSCRIBE = /^tasks\/([^/:]+):subscribe$/;
const TASK_GET = /^tasks\/([^/:]+)$/;
const TASK_PUSH = /^tasks\/[^/:]+\/pushNotificationConfigs(?:\/.*)?$/;

const UNSUPPORTED_STREAM = 'Поток не поддерживается (capabilities.streaming = false): используйте POST /message:send.';
const PUSH_UNSUPPORTED = 'Push-уведомления не поддерживаются (capabilities.pushNotifications = false).';

export async function OPTIONS() {
  return optionsResponse();
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const startedAt = Date.now();
  const path = await pathOf(ctx);
  // Корень биндинга — визитка: человеку и curl удобно, спецификации не мешает.
  if (path === '' || path === 'card') {
    journalA2a(request, 'rest', startedAt, { op: 'card', version: versionOf(request) });
    return NextResponse.json(buildAgentCard(publicBase()), { headers: { 'Cache-Control': 'public, max-age=3600', ...CORS_HEADERS } });
  }
  const v = versionOr400(request, startedAt);
  if (!v.ok) return v.res;

  if (path === 'tasks') return run(request, v.read, 'ListTasks', {}, startedAt);
  if (path === 'extendedAgentCard') return run(request, v.read, 'GetExtendedAgentCard', {}, startedAt);
  if (TASK_PUSH.test(path)) return refuse(request, startedAt, v.read, 'PushNotificationNotSupported', a2aError('PushNotificationNotSupported', PUSH_UNSUPPORTED));
  const get = TASK_GET.exec(path);
  if (get) {
    const hl = request.nextUrl.searchParams.get('historyLength');
    const historyLength = hl !== null && /^\d+$/.test(hl) ? Number(hl) : undefined;
    return run(request, v.read, 'GetTask', { id: decodeURIComponent(get[1]), ...(historyLength !== undefined ? { historyLength } : {}) }, startedAt);
  }
  return noSuchPath(request, startedAt, v.read, path);
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const startedAt = Date.now();
  const path = await pathOf(ctx);
  const v = versionOr400(request, startedAt);
  if (!v.ok) return v.res;

  if (path === 'message:stream') return refuse(request, startedAt, v.read, 'UnsupportedOperation', a2aError('UnsupportedOperation', UNSUPPORTED_STREAM));
  if (TASK_SUBSCRIBE.test(path)) return refuse(request, startedAt, v.read, 'UnsupportedOperation', a2aError('UnsupportedOperation', UNSUPPORTED_STREAM));
  if (TASK_PUSH.test(path)) return refuse(request, startedAt, v.read, 'PushNotificationNotSupported', a2aError('PushNotificationNotSupported', PUSH_UNSUPPORTED));
  const cancel = TASK_CANCEL.exec(path);
  if (cancel) return run(request, v.read, 'CancelTask', { id: decodeURIComponent(cancel[1]) }, startedAt);

  if (path === 'message:send') {
    const raw = await readBodyLimited(request);
    if (raw === null) return refuse(request, startedAt, v.read, 'BodyTooLarge', a2aError('InvalidRequest', `Тело больше ${MAX_BODY_BYTES / 1024} КБ`));
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return refuse(request, startedAt, v.read, 'ParseError', a2aError('ParseError', 'Тело не JSON'));
    }
    return run(request, v.read, 'SendMessage', body, startedAt);
  }
  return noSuchPath(request, startedAt, v.read, path);
}

export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const startedAt = Date.now();
  const path = await pathOf(ctx);
  if (TASK_PUSH.test(path)) return refuse(request, startedAt, versionOf(request), 'PushNotificationNotSupported', a2aError('PushNotificationNotSupported', PUSH_UNSUPPORTED));
  return noSuchPath(request, startedAt, versionOf(request), path);
}
