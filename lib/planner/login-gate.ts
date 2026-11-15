/**
 * Планер — только после входа (слово владельца 14.11: «6 хранить в лк»,
 * «6-3» — «без входа планер не работает»; «нужно ограничивать пользователей
 * без регистрации»).
 *
 * Чистый модуль: его читают страница /planner, экран входа и клиент
 * планера. Без базы и без node-модулей — страница входа собирается в
 * браузере.
 */

/** Адрес планера: туда человека возвращает вход. */
export const PLANNER_PATH = '/planner';

/** Вход с возвратом в планер; `register` — сразу вкладка регистрации. */
export function plannerLoginHref(mode: 'login' | 'register' = 'login'): string {
  const next = `next=${encodeURIComponent(PLANNER_PATH)}`;
  return mode === 'register' ? `/auth/login?mode=register&${next}` : `/auth/login?${next}`;
}

/**
 * Возврат после входа в планер. Только точный путь — открытого
 * перенаправления быть не может (как у приглашения в команду).
 */
export function safePlannerReturn(raw: string | null | undefined): string | null {
  return raw === PLANNER_PATH ? PLANNER_PATH : null;
}

/**
 * Экран вместо планера: просьба войти или честное «не смогли проверить вход»
 * (§4.0) — второе не равно первому: планер не открывается, но «вы не вошли»
 * было бы неправдой.
 */
export type PlannerGate = 'sign_in' | 'unchecked';
