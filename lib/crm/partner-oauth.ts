/**
 * lib/crm/partner-oauth.ts — коды и токены OAuth MCP партнёра (#2325, 1д-2).
 *
 * Подключение по OAuth — строка partner_api_keys, как ключ из кабинета
 * (миграция 1210): токен доступа ищется тем же resolveAgentKey по хешу,
 * отзывается той же кнопкой, отмечает «агент заходил» той же функцией.
 * Отличие — сроки: доступ живёт час, обновление — 90 дней и меняется при
 * каждом обновлении (ротация: старый токен перестаёт действовать в том же
 * UPDATE, что выдаёт новый).
 *
 * Условия владельца для MCP партнёра держатся и здесь: в базе только хеши
 * (код, доступ, обновление), подключение отзывается в кабинете, право записи
 * — только если партнёр отметил его на экране согласия.
 *
 * Код авторизации одноразовый по построению: DELETE ... RETURNING. Второй
 * запрос с тем же кодом строки уже не найдёт, даже если придёт в ту же
 * миллисекунду. Неверный verifier или чужой адрес возврата тоже сжигают код —
 * так требует OAuth 2.1.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { pool } from '@/lib/db-pool';
import { AGENT_KEY_PREFIX, generateAgentKey, hashAgentKey } from '@/lib/crm/agent-keys';
import { SCOPE_READ, SCOPE_WRITE, trustedOAuthClient } from '@/lib/crm/partner-oauth-public';
import { CODE_CHALLENGE_RE } from '@/lib/crm/partner-oauth-request';
import type { PartnerOAuthCodeRow } from '@/lib/types/db-rows';

interface Queryable {
  query: typeof pool.query;
}

export const ACCESS_TTL_SECONDS = 3600;
export const REFRESH_TTL_DAYS = 90;
export const CODE_TTL_SECONDS = 300;
/** Подключений OAuth у партнёра не больше: новое вытесняет самое старое. */
export const MAX_OAUTH_CONNECTIONS = 5;
const SHOWN_CHARS = AGENT_KEY_PREFIX.length + 6;
const REFRESH_PREFIX = 'vdr_rt_';
const CODE_PREFIX = 'vdr_ac_';
const BODY_RE = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636: verifier — 43..128 знаков из unreserved. */
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

function token(prefix: string, randomSource: (n: number) => Buffer): string {
  return `${prefix}${randomSource(32).toString('base64url')}`;
}

function shaped(value: string | null | undefined, prefix: string): value is string {
  return !!value && value.startsWith(prefix) && BODY_RE.test(value.slice(prefix.length));
}

function sqlstate(err: unknown): string {
  return (err as { code?: string })?.code ?? 'нет SQLSTATE';
}

/** PKCE S256: base64url(sha256(verifier)) == challenge. Сравнение — постоянным временем. */
export function verifyPkce(verifier: string | null | undefined, challenge: string): boolean {
  if (!verifier || !VERIFIER_RE.test(verifier) || !CODE_CHALLENGE_RE.test(challenge)) return false;
  const actual = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const expected = Buffer.from(challenge);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function scopeFor(canWrite: boolean): string {
  return canWrite ? `${SCOPE_READ} ${SCOPE_WRITE}` : SCOPE_READ;
}

export interface IssueCodeInput {
  partnerId: string;
  userId: string | null;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  canWrite: boolean;
}

/** Выдать одноразовый код. В базу — хеш; заодно уходят просроченные коды. */
export async function issueAuthorizationCode(
  input: IssueCodeInput,
  db: Queryable = pool,
  randomSource: (n: number) => Buffer = randomBytes,
): Promise<string> {
  const code = token(CODE_PREFIX, randomSource);
  await db.query(`DELETE FROM partner_oauth_codes WHERE expires_at < NOW()`);
  await db.query(
    `INSERT INTO partner_oauth_codes (code_hash, partner_id, user_id, client_id, redirect_uri, code_challenge, can_write, expires_at)
     VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, NOW() + ($8::int * INTERVAL '1 second'))`,
    [hashAgentKey(code), input.partnerId, input.userId, input.clientId, input.redirectUri, input.codeChallenge, input.canWrite, CODE_TTL_SECONDS],
  );
  return code;
}

export interface IssuedTokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/**
 * Исход обмена (§4.0): токены / отказ по правилам OAuth (`invalid_grant` —
 * код или токен обновления не годится) / база не ответила — это не
 * `invalid_grant`: клиент повторит, а не сбросит подключение.
 */
export type TokenOutcome =
  | { outcome: 'ok'; tokens: IssuedTokens }
  | { outcome: 'invalid_grant'; reason: string }
  | { outcome: 'unavailable' };

export interface ExchangeInput {
  code: string | null | undefined;
  clientId: string | null | undefined;
  redirectUri: string | null | undefined;
  codeVerifier: string | null | undefined;
}

export async function exchangeAuthorizationCode(
  input: ExchangeInput,
  db: Queryable = pool,
  randomSource: (n: number) => Buffer = randomBytes,
): Promise<TokenOutcome> {
  if (!shaped(input.code, CODE_PREFIX)) return { outcome: 'invalid_grant', reason: 'код отсутствует или повреждён' };
  try {
    const { rows } = await db.query<Pick<PartnerOAuthCodeRow, 'partner_id' | 'user_id' | 'client_id' | 'redirect_uri' | 'code_challenge' | 'can_write'> & { expired: boolean }>(
      `DELETE FROM partner_oauth_codes WHERE code_hash = $1
       RETURNING partner_id::text AS partner_id, user_id::text AS user_id, client_id, redirect_uri,
                 code_challenge, can_write, expires_at < NOW() AS expired`,
      [hashAgentKey(input.code)],
    );
    const row = rows[0];
    if (!row) return { outcome: 'invalid_grant', reason: 'код неизвестен или уже использован' };
    if (row.expired) return { outcome: 'invalid_grant', reason: 'срок кода истёк — начните подключение заново' };
    if (row.client_id !== input.clientId) return { outcome: 'invalid_grant', reason: 'код выдан другому приложению' };
    if (row.redirect_uri !== input.redirectUri) return { outcome: 'invalid_grant', reason: 'адрес возврата не совпадает с запросом подключения' };
    if (!verifyPkce(input.codeVerifier, row.code_challenge)) return { outcome: 'invalid_grant', reason: 'проверка PKCE не пройдена' };

    const access = generateAgentKey(randomSource);
    const refresh = token(REFRESH_PREFIX, randomSource);
    const label = trustedOAuthClient(row.client_id)?.name ?? 'Агент OAuth';
    await db.query(
      `INSERT INTO partner_api_keys
         (partner_id, label, key_prefix, key_hash, can_write, created_by,
          oauth_client_id, refresh_hash, access_expires_at, refresh_expires_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7, $8,
               NOW() + ($9::int * INTERVAL '1 second'), NOW() + ($10::int * INTERVAL '1 day'))`,
      [row.partner_id, label, access.slice(0, SHOWN_CHARS), hashAgentKey(access), row.can_write, row.user_id,
        row.client_id, hashAgentKey(refresh), ACCESS_TTL_SECONDS, REFRESH_TTL_DAYS],
    );
    // Вытеснение: подключений не больше MAX_OAUTH_CONNECTIONS. Повторное
    // «Подключить» в Claude не должно упираться в предел — уходит старое.
    await db.query(
      `UPDATE partner_api_keys SET revoked_at = NOW()
        WHERE id IN (SELECT id FROM partner_api_keys
                      WHERE partner_id = $1::uuid AND oauth_client_id IS NOT NULL AND revoked_at IS NULL
                      ORDER BY created_at DESC OFFSET $2::int)`,
      [row.partner_id, MAX_OAUTH_CONNECTIONS],
    );
    return {
      outcome: 'ok',
      tokens: { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS, refresh_token: refresh, scope: scopeFor(row.can_write) },
    };
  } catch (err) {
    console.error('[partner-oauth] обмен кода не выполнен, SQLSTATE', sqlstate(err));
    return { outcome: 'unavailable' };
  }
}

export interface RefreshInput {
  refreshToken: string | null | undefined;
  clientId: string | null | undefined;
}

/**
 * Обновить доступ. Одним UPDATE: старый токен обновления, старый доступ и
 * условие «не отозван, не истёк, тот же клиент» — гонки двух обновлений нет,
 * второе не найдёт строку и получит invalid_grant.
 */
export async function refreshAccessToken(
  input: RefreshInput,
  db: Queryable = pool,
  randomSource: (n: number) => Buffer = randomBytes,
): Promise<TokenOutcome> {
  if (!shaped(input.refreshToken, REFRESH_PREFIX) || !input.clientId) {
    return { outcome: 'invalid_grant', reason: 'токен обновления отсутствует или повреждён' };
  }
  const access = generateAgentKey(randomSource);
  const refresh = token(REFRESH_PREFIX, randomSource);
  try {
    const { rows } = await db.query<{ can_write: boolean }>(
      `UPDATE partner_api_keys
          SET key_hash = $2, key_prefix = $3, refresh_hash = $4,
              access_expires_at = NOW() + ($6::int * INTERVAL '1 second'),
              refresh_expires_at = NOW() + ($7::int * INTERVAL '1 day')
        WHERE refresh_hash = $1 AND oauth_client_id = $5
          AND revoked_at IS NULL AND refresh_expires_at > NOW()
        RETURNING can_write`,
      [hashAgentKey(input.refreshToken), hashAgentKey(access), access.slice(0, SHOWN_CHARS), hashAgentKey(refresh),
        input.clientId, ACCESS_TTL_SECONDS, REFRESH_TTL_DAYS],
    );
    const row = rows[0];
    if (!row) return { outcome: 'invalid_grant', reason: 'токен обновления неизвестен, отозван или истёк — подключите агента заново' };
    return {
      outcome: 'ok',
      tokens: { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS, refresh_token: refresh, scope: scopeFor(row.can_write) },
    };
  } catch (err) {
    console.error('[partner-oauth] обновление токена не выполнено, SQLSTATE', sqlstate(err));
    return { outcome: 'unavailable' };
  }
}

/** Название кабинета для экрана согласия. Не прочиталось — null и строка в логе. */
export async function partnerDisplayName(partnerId: string, db: Queryable = pool): Promise<string | null> {
  try {
    const { rows } = await db.query<{ name: string | null }>(
      `SELECT COALESCE(company_name, name) AS name FROM partners WHERE id = $1::uuid`,
      [partnerId],
    );
    return rows[0]?.name ?? null;
  } catch (err) {
    console.error('[partner-oauth] название кабинета не прочитано, SQLSTATE', sqlstate(err));
    return null;
  }
}
