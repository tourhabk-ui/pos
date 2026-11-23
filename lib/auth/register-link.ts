/**
 * Ссылка на регистрацию с заранее выбранной ролью партнёра (план готовности
 * 23.11, этап 3a).
 *
 * До этого дня понятный вход был только у туроператора (`/operators/join`).
 * Гид, хозяин жилья и перевозчик попадали на общую форму, где тип «Партнёр» и
 * своё направление надо было найти самому, — а адреса `/guides/join`,
 * `/stays/join`, `/transfers/join`, `/car-rental/join` отвечали 404. Теперь страница роли ведёт
 * на ту же форму и ту же дверь `/api/auth/register`, но с выбранной ролью:
 * второго пути регистрации нет.
 *
 * Роль из адреса — подсказка форме, а не право: список закрыт, чужое значение
 * (`admin`, мусор) не выбирает ничего, а роль всё равно проверяет сервер.
 * Агента в списке нет намеренно: роль заморожена (lib/auth/agent-role).
 */

export const REGISTER_LINK_ROLES = ['operator', 'guide', 'transfer', 'cars', 'stay', 'gear'] as const;
export type RegisterLinkRole = (typeof REGISTER_LINK_ROLES)[number];

export function isRegisterLinkRole(v: unknown): v is RegisterLinkRole {
  return typeof v === 'string' && (REGISTER_LINK_ROLES as readonly string[]).includes(v);
}

/** Адрес формы регистрации с выбранной ролью. */
export function partnerRegisterPath(role: RegisterLinkRole): string {
  return `/auth/login?mode=register&role=${role}`;
}

/**
 * Роль из строки запроса формы входа. null — роли нет, она не из списка или
 * адрес не просит регистрацию: форма остаётся как была.
 */
export function registerRoleFromSearch(search: string): RegisterLinkRole | null {
  const params = new URLSearchParams(search);
  if (params.get('mode') !== 'register') return null;
  const role = params.get('role');
  return isRegisterLinkRole(role) ? role : null;
}
