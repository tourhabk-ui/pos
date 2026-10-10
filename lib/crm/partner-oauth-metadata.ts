/**
 * lib/crm/partner-oauth-metadata.ts — документы обнаружения OAuth MCP
 * партнёра и заголовок 401.
 *
 * Путь приложения Claude к входу (документация Anthropic «Authentication
 * for connectors», сверено 10.10):
 *   1. запрос к /api/mcp/partner без токена → 401 с
 *      `WWW-Authenticate: Bearer resource_metadata="…"` — только 401
 *      начинает вход, тот же заголовок на 200 Claude не читает;
 *   2. метаданные ресурса (RFC 9728): `resource` побуквенно равен адресу,
 *      который партнёр ввёл в Claude; первым в `authorization_servers` —
 *      наш издатель (Claude берёт только первый);
 *   3. метаданные сервера авторизации (RFC 8414): Claude выбирает CIMD,
 *      только если есть И `client_id_metadata_document_supported: true`,
 *      И `"none"` среди способов входа на токен-эндпоинт — иначе ищет
 *      регистрацию клиентов, которой у нас нет намеренно.
 */
import {
  OAUTH_ISSUER,
  PARTNER_MCP_RESOURCE,
  PARTNER_OAUTH_AUTHORIZE_PATH,
  PARTNER_OAUTH_PRM_PATH,
  PARTNER_OAUTH_TOKEN_PATH,
  SCOPE_READ,
  SCOPE_WRITE,
} from '@/lib/crm/partner-oauth-public';

export const PARTNER_OAUTH_PRM_URL = `${OAUTH_ISSUER}${PARTNER_OAUTH_PRM_PATH}`;

export function protectedResourceMetadata() {
  return {
    resource: PARTNER_MCP_RESOURCE,
    authorization_servers: [OAUTH_ISSUER],
    scopes_supported: [SCOPE_READ, SCOPE_WRITE],
    bearer_methods_supported: ['header'],
    resource_name: 'Ведар — CRM партнёра',
  };
}

export function authorizationServerMetadata() {
  return {
    issuer: OAUTH_ISSUER,
    authorization_endpoint: `${OAUTH_ISSUER}${PARTNER_OAUTH_AUTHORIZE_PATH}`,
    token_endpoint: `${OAUTH_ISSUER}${PARTNER_OAUTH_TOKEN_PATH}`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    // offline_access: Claude добавляет его к запросу, только если видит здесь,
    // и так явно просит токен обновления. Мы выдаём его всегда.
    scopes_supported: [SCOPE_READ, SCOPE_WRITE, 'offline_access'],
    authorization_response_iss_parameter_supported: true,
  };
}

/**
 * Заголовок 401. `scope` — чтение и запись: право записи всё равно
 * включает партнёр на экране согласия (по умолчанию выключено), а без
 * запроса записи этот флажок нечем было бы показать. `error="invalid_token"`
 * — когда токен прислан, но не годится (истёк, отозван): по нему клиент
 * обновляет токен, а не начинает вход с нуля.
 */
export function partnerWwwAuthenticate(presented: boolean): string {
  const parts = [
    ...(presented ? ['error="invalid_token"'] : []),
    `resource_metadata="${PARTNER_OAUTH_PRM_URL}"`,
    `scope="${SCOPE_READ} ${SCOPE_WRITE}"`,
  ];
  return `Bearer ${parts.join(', ')}`;
}
