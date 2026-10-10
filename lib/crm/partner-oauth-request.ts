/**
 * lib/crm/partner-oauth-request.ts — проверка запроса авторизации OAuth MCP
 * партнёра: экран согласия и роут решения судят его одной функцией.
 *
 * Три исхода, как требует OAuth 2.1:
 *  - fatal — клиент или адрес возврата не проверены: ошибку показываем сами
 *    и никуда не перенаправляем (иначе это открытое перенаправление);
 *  - error — клиент и адрес проверены, но запрос неверен: ошибка уходит
 *    клиенту на его адрес возврата, с его state;
 *  - ok — можно спрашивать согласие.
 */
import {
  OAUTH_ISSUER,
  PARTNER_MCP_RESOURCE,
  SCOPE_READ,
  SCOPE_WRITE,
  resolvePartnerOAuthClient,
  type PartnerOAuthClient,
} from '@/lib/crm/partner-oauth-public';

/** Вызов PKCE: base64url от sha256 — ровно 43 знака. */
export const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const STATE_MAX = 1024;
const KNOWN_SCOPES = new Set([SCOPE_READ, SCOPE_WRITE, 'offline_access']);

export interface AuthorizeParams {
  response_type?: string | null;
  client_id?: string | null;
  redirect_uri?: string | null;
  code_challenge?: string | null;
  code_challenge_method?: string | null;
  state?: string | null;
  scope?: string | null;
  resource?: string | null;
}

export const AUTHORIZE_PARAM_NAMES = [
  'response_type', 'client_id', 'redirect_uri', 'code_challenge',
  'code_challenge_method', 'state', 'scope', 'resource',
] as const;

export interface ValidAuthorizeRequest {
  client: PartnerOAuthClient;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  /** Клиент просил право записи. Дать его или нет — решает партнёр, по умолчанию нет. */
  wantsWrite: boolean;
}

export type AuthorizeCheck =
  | { kind: 'fatal'; message: string }
  | { kind: 'error'; redirect: string }
  | { kind: 'ok'; request: ValidAuthorizeRequest };

/**
 * Адрес возврата с параметрами ответа. `iss` — RFC 9207: клиент сверяет, что
 * ответ пришёл от того сервера, к которому он ходил.
 */
export function redirectWith(redirectUri: string, params: Record<string, string | null>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) {
    if (v !== null) u.searchParams.set(k, v);
  }
  u.searchParams.set('iss', OAUTH_ISSUER);
  return u.toString();
}

export function denyRedirect(request: Pick<ValidAuthorizeRequest, 'redirectUri' | 'state'>): string {
  return redirectWith(request.redirectUri, { error: 'access_denied', state: request.state });
}

export function checkAuthorizeRequest(p: AuthorizeParams): AuthorizeCheck {
  const client = resolvePartnerOAuthClient(p.client_id, p.redirect_uri);
  if (!client || !p.redirect_uri) {
    return {
      kind: 'fatal',
      message: 'Ссылка подключения не от Claude или повреждена. Начните подключение заново в Claude: «Настройки» → «Коннекторы».',
    };
  }
  const redirectUri = p.redirect_uri;
  const state = p.state ?? null;
  if (state !== null && state.length > STATE_MAX) {
    return { kind: 'fatal', message: 'Ссылка подключения слишком длинная. Начните подключение заново в Claude.' };
  }
  const fail = (error: string, description: string): AuthorizeCheck => ({
    kind: 'error',
    redirect: redirectWith(redirectUri, { error, error_description: description, state }),
  });

  if (p.response_type !== 'code') return fail('unsupported_response_type', 'поддерживается только response_type=code');
  if (p.code_challenge_method !== 'S256') return fail('invalid_request', 'нужен PKCE с code_challenge_method=S256');
  if (!p.code_challenge || !CODE_CHALLENGE_RE.test(p.code_challenge)) return fail('invalid_request', 'code_challenge отсутствует или повреждён');
  // RFC 8707: токены выдаются только для одного ресурса — MCP партнёра.
  if (p.resource && p.resource !== PARTNER_MCP_RESOURCE) return fail('invalid_target', `ресурс этого сервера — ${PARTNER_MCP_RESOURCE}`);

  const scopes = (p.scope ?? '').split(' ').filter(Boolean);
  if (scopes.some((s) => !KNOWN_SCOPES.has(s))) {
    return fail('invalid_scope', `поддерживаются права ${SCOPE_READ} и ${SCOPE_WRITE}`);
  }

  return {
    kind: 'ok',
    request: { client, redirectUri, codeChallenge: p.code_challenge, state, wantsWrite: scopes.includes(SCOPE_WRITE) },
  };
}
