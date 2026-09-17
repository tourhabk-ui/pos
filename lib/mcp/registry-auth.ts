/**
 * Доказательство владения именем `ru.vedarai/mcp` в официальном реестре MCP.
 *
 * Реестр (registry.modelcontextprotocol.io) требует показать, что домен
 * `vedarai.ru` наш: TXT-записью на апексе или файлом
 * `/.well-known/mcp-registry-auth`. Файл живёт в репозитории вместе с
 * сервером, который удостоверяет, — смена DNS-хостинга его не теряет.
 *
 * Строка одна, формата реестра: `v=MCPv1; k=ed25519; p=<ключ>`, где ключ —
 * публичная половина пары Ed25519 в base64. Приватная половина в репозиторий
 * не попадает никогда: ею владелец подписывает `mcp-publisher login http` со
 * своей машины.
 *
 * ── Третье состояние ──────────────────────────────────────────────────────
 *
 * Ключ приходит из переменной окружения, не из кода. Пока её нет —
 * `not_configured` (404 снаружи), а не заглушка: заглушка по публичному
 * адресу выглядит как доказательство, ничего не доказывая, и реестр отказал
 * бы на ней сообщением, по которому не понять, что не так. Битый ключ —
 * `malformed` (500 с именем переменной): тот, кто запускает публикацию,
 * увидит причину в первом же ответе.
 */

export const MCP_REGISTRY_AUTH_ENV = 'MCP_REGISTRY_AUTH_PUBKEY';

/** Публичный ключ Ed25519 — 32 байта, в base64 это ровно 43 символа и «=». */
const ED25519_PUBKEY_B64 = /^[A-Za-z0-9+/]{43}=$/;

export function registryAuthLine(pubkey: string): string {
  return `v=MCPv1; k=ed25519; p=${pubkey}`;
}

export type RegistryAuthState =
  | { state: 'ok'; line: string }
  | { state: 'not_configured' }
  | { state: 'malformed'; reason: string };

export function registryAuthState(env: NodeJS.ProcessEnv = process.env): RegistryAuthState {
  const raw = env[MCP_REGISTRY_AUTH_ENV]?.trim() ?? '';
  if (!raw) return { state: 'not_configured' };
  if (!ED25519_PUBKEY_B64.test(raw)) {
    return {
      state: 'malformed',
      reason: `${MCP_REGISTRY_AUTH_ENV} не похож на публичный ключ Ed25519 в base64 (ожидается 44 символа)`,
    };
  }
  return { state: 'ok', line: registryAuthLine(raw) };
}
