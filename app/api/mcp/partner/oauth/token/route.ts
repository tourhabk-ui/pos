/**
 * POST /api/mcp/partner/oauth/token — токен-эндпоинт OAuth MCP партнёра.
 *
 * Два гранта: обмен одноразового кода (authorization_code, PKCE S256) и
 * обновление (refresh_token, с ротацией). Клиент публичный — секрета нет,
 * его заменяет PKCE (`token_endpoint_auth_methods_supported: ["none"]`).
 *
 * Требования Claude (документация Anthropic, сверено 10.10):
 *  - тело — application/x-www-form-urlencoded (RFC 6749 §4.1.3); JSON тоже
 *    принимаем, но Claude шлёт форму;
 *  - негодный код или токен обновления — `invalid_grant`, а не свой код:
 *    по нему клиент понимает, что подключение надо начать заново;
 *  - ответ быстрый: Claude ждёт 10 секунд обмена и 30 — обновления.
 * База не ответила — 503 `temporarily_unavailable`, а не `invalid_grant`:
 * «не смогли проверить» не равно «токен плохой» (§4.0), и подключение не
 * должно сбрасываться из-за нашей минуты простоя.
 *
 * Edge пропускает префикс /api/mcp без JWT (middleware.ts не тронут): здесь
 * входа и не нужно — доказательство владения кодом даёт PKCE.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { PARTNER_MCP_RESOURCE } from '@/lib/crm/partner-oauth-public';
import { exchangeAuthorizationCode, refreshAccessToken, type TokenOutcome } from '@/lib/crm/partner-oauth';
import { readBodyLimited } from '@/lib/mcp/read-body';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const ipLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });

const field = z.string().max(2048).optional();
const TokenRequestSchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    code: z.string().max(256),
    redirect_uri: z.string().max(512),
    client_id: z.string().max(512),
    code_verifier: z.string().max(128),
    resource: field,
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().max(256),
    client_id: z.string().max(512),
    scope: field,
    resource: field,
  }),
]);

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

function oauthError(error: string, description: string, status = 400): NextResponse {
  return NextResponse.json({ error, error_description: description }, { status, headers: NO_STORE });
}

function parseBody(raw: string, contentType: string): Record<string, string> | null {
  if (contentType.includes('application/json')) {
    try {
      const v: unknown = JSON.parse(raw);
      if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
      return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'));
    } catch {
      return null;
    }
  }
  const params = new URLSearchParams(raw);
  const out: Record<string, string> = {};
  for (const [k, v] of params) {
    // RFC 6749 §3.2: параметр не повторяется. Повтор — ошибка, а не «взять первый».
    if (k in out) return null;
    out[k] = v;
  }
  return out;
}

function answer(result: TokenOutcome): NextResponse {
  if (result.outcome === 'ok') return NextResponse.json(result.tokens, { headers: NO_STORE });
  if (result.outcome === 'invalid_grant') return oauthError('invalid_grant', result.reason);
  return oauthError('temporarily_unavailable', 'Сервер не смог проверить запрос — повторите позже', 503);
}

export async function POST(request: NextRequest) {
  if (!ipLimiter.check(getTrustedClientIp(request.headers))) {
    return oauthError('slow_down', 'Слишком много запросов — подождите минуту', 429);
  }
  const raw = await readBodyLimited(request);
  if (raw === null) return oauthError('invalid_request', 'Тело запроса слишком большое');
  const body = parseBody(raw, request.headers.get('content-type') ?? '');
  if (!body) return oauthError('invalid_request', 'Тело запроса не разобрано или параметр повторён');

  if (body.grant_type !== 'authorization_code' && body.grant_type !== 'refresh_token') {
    return oauthError('unsupported_grant_type', 'Поддерживаются authorization_code и refresh_token');
  }
  const parsed = TokenRequestSchema.safeParse(body);
  if (!parsed.success) {
    return oauthError('invalid_request', `Не хватает параметра: ${parsed.error.issues[0]?.path.join('.') ?? 'тело'}`);
  }
  const req = parsed.data;
  // RFC 8707: токены этого сервера годятся только для MCP партнёра.
  if (req.resource && req.resource !== PARTNER_MCP_RESOURCE) {
    return oauthError('invalid_target', `ресурс этого сервера — ${PARTNER_MCP_RESOURCE}`);
  }

  if (req.grant_type === 'authorization_code') {
    return answer(await exchangeAuthorizationCode({
      code: req.code,
      clientId: req.client_id,
      redirectUri: req.redirect_uri,
      codeVerifier: req.code_verifier,
    }));
  }
  return answer(await refreshAccessToken({ refreshToken: req.refresh_token, clientId: req.client_id }));
}
