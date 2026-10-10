/**
 * lib/crm/partner-oauth-public.ts — адреса и правила OAuth MCP партнёра,
 * которые нужны и серверу, и браузеру (страница входа, панель ключей, экран
 * согласия). Без импортов: модуль попадает в клиентскую сборку.
 *
 * Зачем OAuth рядом с ключом (CRM #2325, 1д-2). Ключ из кабинета клиент
 * присылает заголовком Authorization — так умеют Claude Code, Cursor, API и
 * свои агенты. Приложение Claude (сайт, десктоп, телефон) заголовок
 * принимает только у части организаций, это бета; у обычного партнёра путь
 * один — «Подключить» и вход на нашем сайте. Требования Claude к серверу —
 * документация Anthropic «Authentication for connectors», сверено 10.10.
 *
 * Кому доверяем. Claude представляется документом CIMD: client_id — это
 * адрес документа на claude.ai. Скачивать документ с прода мы не станем:
 * claude.ai из РФ может быть закрыт, и подключение зависело бы от чужого
 * гео-блока. Вместо этого правило: client_id — https-адрес на claude.ai, а
 * вернуть код можно только туда, где его заберёт сам Claude:
 *   - приложение Claude — https://claude.ai/api/mcp/auth_callback;
 *   - Claude Code — loopback на этом же компьютере, порт любой, путь /callback
 *     (его документ: https://claude.ai/oauth/claude-code-client-metadata,
 *     в нём ровно http://localhost/callback и http://127.0.0.1/callback).
 * Контент на claude.ai контролирует только Anthropic, поэтому подделать
 * клиента с этим client_id и чужим адресом возврата нельзя — адрес возврата
 * мы не берём из документа, а сверяем с этим списком.
 */

/** Канон сайта. Совпадает с CANONICAL_BASE_URL (lib/config.ts) — держит сторож partner-mcp-oauth. */
export const OAUTH_ISSUER = 'https://vedarai.ru';
export const PARTNER_MCP_PATH = '/api/mcp/partner';
/**
 * Адрес сервера, который партнёр вводит в Claude. Claude сверяет его с полем
 * `resource` наших метаданных побуквенно — с www или со слешем на конце
 * вход не пройдёт.
 */
export const PARTNER_MCP_RESOURCE = `${OAUTH_ISSUER}${PARTNER_MCP_PATH}`;
export const PARTNER_OAUTH_PRM_PATH = `/.well-known/oauth-protected-resource${PARTNER_MCP_PATH}`;
export const PARTNER_OAUTH_AS_PATH = '/.well-known/oauth-authorization-server';
/** Экран согласия — вне /hub: Edge-гейт /hub при входе теряет параметры запроса. */
export const PARTNER_OAUTH_AUTHORIZE_PATH = '/oauth/partner/authorize';
/** Решение партнёра (разрешить / отказать) — под /api/mcp: Edge пропускает префикс, вход проверяет роут. */
export const PARTNER_OAUTH_DECISION_API = '/api/mcp/partner/oauth/authorize';
export const PARTNER_OAUTH_TOKEN_PATH = '/api/mcp/partner/oauth/token';

export const SCOPE_READ = 'crm.read';
export const SCOPE_WRITE = 'crm.write';

const CLAUDE_ORIGIN = 'https://claude.ai';
export const CLAUDE_CODE_CLIENT_ID = 'https://claude.ai/oauth/claude-code-client-metadata';
export const CLAUDE_APP_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface PartnerOAuthClient {
  clientId: string;
  /** Как назвать приложение на экране согласия и в списке кабинета. */
  name: string;
  /** Куда уйдёт код — словами для экрана согласия. */
  destination: string;
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** client_id, которому мы доверяем, или null. Имя — по адресу, а не из документа клиента. */
export function trustedOAuthClient(clientId: string | null | undefined): Omit<PartnerOAuthClient, 'destination'> | null {
  if (!clientId || clientId.length > 512) return null;
  const u = parse(clientId);
  if (!u || u.origin !== CLAUDE_ORIGIN || u.username || u.password || u.hash) return null;
  // CIMD требует путь: адрес самого сайта документом клиента не бывает.
  if (u.pathname === '/' || u.pathname === '') return null;
  return { clientId, name: clientId === CLAUDE_CODE_CLIENT_ID ? 'Claude Code' : 'Claude' };
}

function isLoopbackCallback(u: URL): boolean {
  return u.protocol === 'http:'
    && LOOPBACK_HOSTS.has(u.hostname)
    && u.pathname === '/callback'
    && !u.username && !u.password && !u.hash;
}

/**
 * Клиент и адрес возврата вместе. null — запрос подключения нельзя выполнить
 * и нельзя даже вернуть ошибку по адресу возврата: он не проверен.
 */
export function resolvePartnerOAuthClient(clientId: string | null | undefined, redirectUri: string | null | undefined): PartnerOAuthClient | null {
  const client = trustedOAuthClient(clientId);
  if (!client || !redirectUri || redirectUri.length > 512) return null;
  if (redirectUri === CLAUDE_APP_CALLBACK && client.clientId !== CLAUDE_CODE_CLIENT_ID) {
    return { ...client, destination: 'claude.ai' };
  }
  const u = parse(redirectUri);
  if (u && client.clientId === CLAUDE_CODE_CLIENT_ID && isLoopbackCallback(u)) {
    return { ...client, destination: `программа на этом компьютере (${u.hostname})` };
  }
  return null;
}

/**
 * Куда вернуть человека после входа на сайт. Узко: только экран согласия
 * OAuth, и только путь этого сайта — открытого перенаправления быть не
 * может. Всё прочее — null, и вход ведёт в кабинет, как раньше.
 */
export function safePartnerOAuthReturn(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 4096) return null;
  if (!raw.startsWith(`${PARTNER_OAUTH_AUTHORIZE_PATH}?`)) return null;
  if (raw.includes('\\') || /[\u0000-\u001f]/.test(raw)) return null;
  const u = parse(`${OAUTH_ISSUER}${raw}`);
  if (!u || u.origin !== OAUTH_ISSUER || u.pathname !== PARTNER_OAUTH_AUTHORIZE_PATH) return null;
  return `${u.pathname}${u.search}`;
}
