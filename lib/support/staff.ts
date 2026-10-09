/**
 * lib/support/staff.ts — кто служба поддержки. Чистый модуль.
 *
 * До 09.10 роуты тикетов считали службой поддержки `admin` ИЛИ `agent`:
 * в переписке тикета автор-сотрудник и сейчас помечается словом «agent».
 * Но роль `agent` в платформе — турагент, и её выдаёт самостоятельная
 * регистрация (/api/auth/register). Любой, кто назвался турагентом, читал
 * ВСЕ тикеты всех пользователей — имена, почту, текст обращений — и отвечал
 * в них от имени поддержки. Тот же род дефекта закрыт для лидов 26.09
 * (app/api/agent/leads).
 *
 * Отдельной роли сотрудника поддержки нет; пока её нет — это администратор.
 * Роуты с `requireRole` берут список отсюда же (`SUPPORT_STAFF_ROLES`).
 */
export const SUPPORT_STAFF_ROLES: readonly string[] = ['admin'];

export function isSupportStaff(role: string | null | undefined): boolean {
  return typeof role === 'string' && SUPPORT_STAFF_ROLES.includes(role);
}
