/**
 * lib/ai/chat-role.ts
 *
 * Роль собеседника веб-чата — из входа, а не из тела запроса (10.11).
 *
 * `/api/ai/chat` и `/api/ai/chat-stream` принимали поле `role` от клиента и
 * верили ему. Роль выбирает не только промпт: в `/api/ai/chat` по ней
 * открываются `PlatformAgent` (у `admin` в матрице прав «*» — публикация в
 * канал, разбор заявок) и ветка инструментов оператора. Туристом
 * регистрируется кто угодно, а прислать `role: "admin"` может любой вошедший —
 * матрица прав `canDispatchIntent` спрашивала ту самую присланную роль.
 *
 * Правило: туристом можно назваться всегда; любой другой ролью — только той,
 * что записана во входе (JWT). Не совпало — разговор идёт как с туристом, а
 * несовпадение пишется в лог именами ролей (без id и ПД). Ни один экран
 * сейчас не шлёт ничего, кроме `tourist`, так что честному клиенту правило
 * ничего не меняет.
 */
import type { ChatRole } from '@/lib/ai/prompts';

export const CHAT_ROLES: readonly ChatRole[] = ['tourist', 'operator', 'guide', 'admin', 'agent', 'transfer'];

function isChatRole(value: unknown): value is ChatRole {
  return typeof value === 'string' && (CHAT_ROLES as readonly string[]).includes(value);
}

export interface ChatRoleDecision {
  role: ChatRole;
  /** Просили не туриста, а вход эту роль не подтвердил. */
  downgraded: boolean;
}

/**
 * Роль, с которой чат вправе говорить.
 *
 * @param requested роль из тела запроса (что угодно)
 * @param signedRole роль из проверенного JWT; `null` — вход не предъявлен
 */
export function effectiveChatRole(requested: unknown, signedRole: string | null | undefined): ChatRoleDecision {
  const asked: ChatRole = isChatRole(requested) ? requested : 'tourist';
  if (asked === 'tourist') return { role: 'tourist', downgraded: false };
  if (signedRole === asked) return { role: asked, downgraded: false };
  return { role: 'tourist', downgraded: true };
}

/** Строка лога о несовпадении: только имена ролей. */
export function logRoleDowngrade(scope: string, requested: unknown, signedRole: string | null | undefined): void {
  console.warn(`[${scope}] роль из запроса не подтверждена входом — разговор как с туристом`, {
    requested: isChatRole(requested) ? requested : 'unknown',
    signed: isChatRole(signedRole) ? signedRole : (signedRole ? 'other' : 'anonymous'),
  });
}
