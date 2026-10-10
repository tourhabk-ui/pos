/**
 * POST /api/mcp/partner — MCP партнёра к своей CRM (CRM #2325, шаг 1д-2).
 *
 * Партнёр выпускает ключ в кабинете («Задачи» → «Свой ИИ-агент») и отдаёт его
 * своему агенту: `Authorization: Bearer vdr_pk_…`. Edge пропускает весь
 * префикс /api/mcp без JWT (middleware.ts, публичный MCP) — middleware.ts
 * этим PR не тронут, проверка ключа живёт здесь, до разбора тела.
 *
 * Вход второй дорогой — OAuth (кнопка «Подключить» в приложении Claude):
 * токен доступа ищется тем же resolveAgentKey, что ключ. 401 несёт
 * `resource_metadata` — по нему Claude находит наш сервер авторизации
 * (lib/crm/partner-oauth-public.ts); без этого указателя приложение Claude
 * не начнёт вход вовсе.
 *
 * Исходы проверки ключа (§4.0):
 *   нет ключа / неверный / отозван / истёк доступ OAuth — 401 с WWW-Authenticate;
 *   CRM этой записи не положена (агент без одобрения) — 403;
 *   база не ответила — 503, а не 401: «не смогли проверить» не равно
 *   «ключа нет».
 *
 * CORS не открыт: ключ — секрет партнёра, и браузерной странице держать его
 * незачем. Лимиты в памяти процесса: на адрес — до проверки ключа (перебор
 * ключей упирается в него раньше, чем в базу), на ключ — после.
 */
import { NextRequest, NextResponse } from 'next/server';
import { bearerKey, resolveAgentKey, touchAgentKey } from '@/lib/crm/agent-keys';
import { handlePartnerMessage } from '@/lib/mcp/partner-server';
import { jsonrpcError } from '@/lib/mcp/jsonrpc';
import { isSupportedProtocolVersion, SUPPORTED_PROTOCOL_VERSIONS } from '@/lib/mcp/protocol-version';
import { MAX_BODY_BYTES, readBodyLimited } from '@/lib/mcp/read-body';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { partnerWwwAuthenticate } from '@/lib/crm/partner-oauth-metadata';

export const dynamic = 'force-dynamic';

/** На адрес: щедро для живого агента, тесно для перебора ключей. */
const ipLimiter = createRateLimiter({ windowMs: 60_000, max: 120 });
/** На ключ: агент партнёра, а не выгрузка всей базы циклом. */
const keyLimiter = createRateLimiter({ windowMs: 60_000, max: 60 });
const MAX_BATCH = 20;

function unauthorized(message: string, presented: boolean): NextResponse {
  return NextResponse.json(jsonrpcError(null, -32001, message), {
    status: 401,
    headers: { 'WWW-Authenticate': partnerWwwAuthenticate(presented) },
  });
}

/** Поток событий не поддерживается — честное 405, как у публичного сервера. */
export async function GET() {
  return new NextResponse(null, { status: 405, headers: { Allow: 'POST' } });
}

export async function POST(request: NextRequest) {
  // Адрес — из заголовка прокси, а не из X-Forwarded-For, который пишет сам
  // клиент (тот же приём, что у публичного MCP).
  if (!ipLimiter.check(getTrustedClientIp(request.headers))) {
    return NextResponse.json(jsonrpcError(null, -32029, 'Слишком много запросов — подождите минуту'), { status: 429 });
  }

  const presentedKey = bearerKey(request.headers.get('authorization'));
  const lookup = await resolveAgentKey(presentedKey);
  if (lookup.outcome === 'invalid') {
    return unauthorized(
      'Нужен вход партнёра: «Подключить» в Claude либо ключ Authorization: Bearer vdr_pk_… (выпускается в кабинете на vedarai.ru)',
      presentedKey !== null,
    );
  }
  if (lookup.outcome === 'no_crm') {
    return NextResponse.json(jsonrpcError(null, -32003, 'CRM этого кабинета недоступна: профиль не одобрен'), { status: 403 });
  }
  if (lookup.outcome === 'unavailable') {
    return NextResponse.json(jsonrpcError(null, -32603, 'Не удалось проверить ключ — повторите позже'), { status: 503 });
  }
  const key = lookup.key;

  if (!keyLimiter.check(key.keyId)) {
    return NextResponse.json(jsonrpcError(null, -32029, 'Слишком много запросов по этому ключу — подождите минуту'), { status: 429 });
  }

  const headerVersion = request.headers.get('mcp-protocol-version');
  if (headerVersion !== null && !isSupportedProtocolVersion(headerVersion)) {
    return NextResponse.json(
      jsonrpcError(null, -32600, `Unsupported MCP-Protocol-Version: ${headerVersion.slice(0, 40)}. Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`),
      { status: 400 },
    );
  }

  const raw = await readBodyLimited(request);
  if (raw === null) {
    return NextResponse.json(jsonrpcError(null, -32600, `Invalid Request: тело больше ${MAX_BODY_BYTES / 1024} КБ`), { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json(jsonrpcError(null, -32700, 'Parse error'), { status: 400 });
  }

  void touchAgentKey(key.keyId);

  try {
    if (Array.isArray(body)) {
      if (body.length === 0) {
        return NextResponse.json(jsonrpcError(null, -32600, 'Invalid Request: пустой пакет'), { status: 400 });
      }
      const replies = [];
      for (const item of body.slice(0, MAX_BATCH)) {
        const reply = await handlePartnerMessage(item, key);
        if (reply) replies.push(reply);
      }
      if (body.length > MAX_BATCH) {
        replies.push(jsonrpcError(null, -32600, `Invalid Request: в пакете больше ${MAX_BATCH} сообщений, лишние не обработаны`));
      }
      return replies.length > 0 ? NextResponse.json(replies) : new NextResponse(null, { status: 202 });
    }

    const reply = await handlePartnerMessage(body, key);
    if (!reply) return new NextResponse(null, { status: 202 });
    const invalid = 'error' in reply && reply.error.code === -32600;
    return NextResponse.json(reply, invalid ? { status: 400 } : undefined);
  } catch (err) {
    const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error('[mcp-partner] необработанная ошибка, SQLSTATE', code);
    return NextResponse.json(jsonrpcError(null, -32603, 'Внутренняя ошибка сервера — повторите позже.'), { status: 500 });
  }
}
