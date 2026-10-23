/**
 * Ключи `users.preferences`, которые назначает сервер, а не сам человек.
 *
 * Находка 23.10: PUT /api/profile писал `preferences` целиком, как прислал
 * клиент. А `preferences.roles` — список ролей человека, по которому
 * /api/auth/switch-role пускает в роль (`lib/auth/role-switch`). Любой
 * зарегистрированный турист присылал `{ preferences: { roles: ['admin'] } }`
 * и следующим запросом входил администратором.
 *
 * Пишут эти ключи только серверные пути: регистрация и switch-role (`roles`),
 * назначение роли администратором (`operator_level`, POST /api/roles),
 * выдача аккаунта и смена пароля (`force_password_change`). Человек меняет
 * свои настройки — эти ключи остаются прежними, что бы он ни прислал.
 */

export const SERVER_OWNED_PREFERENCE_KEYS = ['roles', 'force_password_change', 'operator_level'] as const;

/**
 * SQL-выражение для `SET preferences = …`: присланные настройки без ключей
 * сервера, поверх — ключи сервера из прежней строки (нет ключа — его и не
 * будет). `param` — плейсхолдер присланного JSON, например `$3`.
 */
export function userPreferencesSql(param: string): string {
  const dropSent = SERVER_OWNED_PREFERENCE_KEYS.map((k) => ` - '${k}'`).join('');
  const keepStored = SERVER_OWNED_PREFERENCE_KEYS.map((k) => `'${k}', preferences->'${k}'`).join(', ');
  return `(${param}::jsonb${dropSent}) || jsonb_strip_nulls(jsonb_build_object(${keepStored}))`;
}
