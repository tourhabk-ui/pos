/**
 * Логика переключения активной роли («войти как …»).
 *
 * Активная роль хранится в users.role (её видит JWT и гарды). Список ролей,
 * которыми владеет пользователь, — в users.preferences.roles[]. Владелец (admin)
 * может переключиться в любую роль (god-mode для демо/показа всех интерфейсов);
 * обычный мультироль-пользователь — только в свои.
 *
 * Чистые функции — без БД/сети, покрыты тестами.
 */

/** Канонический список переключаемых ролей (совпадает с ключами ROLE_HUB без алиасов). */
export const SWITCHABLE_ROLES = [
  'tourist', 'operator', 'guide', 'transfer', 'agent', 'stay', 'gear', 'admin',
] as const;

export type SwitchableRole = (typeof SWITCHABLE_ROLES)[number];

export const ROLE_LABELS: Record<string, string> = {
  tourist: 'Турист',
  operator: 'Туроператор',
  guide: 'Гид',
  transfer: 'Трансфер',
  transfer_operator: 'Трансфер',
  agent: 'Агент',
  stay: 'Жильё',
  gear: 'Прокат',
  admin: 'Админ',
};

export function isSwitchableRole(role: string): role is SwitchableRole {
  return (SWITCHABLE_ROLES as readonly string[]).includes(role);
}

/** Роли, которыми владеет пользователь: preferences.roles ∪ текущая активная. */
export function ownedRoles(preferencesRoles: unknown, activeRole: string | null): string[] {
  const fromPrefs = Array.isArray(preferencesRoles)
    ? preferencesRoles.filter((r): r is string => typeof r === 'string')
    : [];
  const set = new Set(fromPrefs);
  if (activeRole) set.add(activeRole);
  return [...set].filter(isSwitchableRole);
}

/**
 * Роли, доступные для переключения из текущей.
 * admin — god-mode: любая роль. Иначе — только собственные.
 */
export function availableForSwitch(activeRole: string | null, owned: string[]): string[] {
  if (activeRole === 'admin') return [...SWITCHABLE_ROLES];
  return [...SWITCHABLE_ROLES].filter((r) => owned.includes(r));
}

/** Можно ли переключиться в target из текущей роли. */
export function canSwitchTo(activeRole: string | null, owned: string[], target: string): boolean {
  if (!isSwitchableRole(target)) return false;
  return availableForSwitch(activeRole, owned).includes(target);
}

/**
 * Новый список owned-ролей после переключения. Для admin бутстрапим
 * {admin, target} в собственные роли — чтобы владелец после «войти как турист»
 * всегда мог вернуться в admin (admin остаётся в его owned).
 */
export function nextOwnedRoles(activeRole: string | null, owned: string[], target: string): string[] {
  const set = new Set<string>(owned.filter(isSwitchableRole));
  if (activeRole === 'admin') {
    set.add('admin');
    set.add(target);
  }
  return [...set];
}
