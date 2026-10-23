/**
 * Смена роли человека администратором (PATCH /api/admin/users/[id]).
 *
 * Ревью 23.10 (закрытие самоназначения через PUT /api/profile): прежний PATCH
 * писал только `users.role`. Снятый с админа человек оставался с `admin` в
 * собственных ролях (`preferences.roles` — его туда кладёт и god-mode
 * switch-role, и закрытая дверь профиля), и следующим запросом
 * /api/auth/switch-role возвращал себе админа. Старый админский токен при этом
 * продолжал проходить requireAdmin до 7 дней: роль зашита в JWT, а сессии
 * PATCH не трогал. Записи о смене в журнале не было вовсе.
 *
 * Теперь одной транзакцией:
 * - назначение `admin` кладёт `admin` в собственные роли;
 * - любая другая роль убирает `admin` из собственных ролей, и если админ у
 *   человека был — его сессии отзываются (войти заново он сможет, админом —
 *   нет);
 * - смена пишется в audit_log (`role_change`: роль, прежняя роль, кто сменил,
 *   сколько сессий отозвано). Не записалась — смены нет: выдача админа без
 *   следа — ровно то, что перепись admin-owners-census не смогла бы отличить
 *   от подделки.
 */

import type { PoolClient } from 'pg';
import { ownedRoles } from '@/lib/auth/role-switch';

export interface AdminRoleChange {
  previousRole: string;
  ownedAdminBefore: boolean;
  sessionsRevoked: number;
}

type Db = Pick<PoolClient, 'query'>;

/** Собственные роли после смены: управляется только `admin`, прочие — как были. */
export function ownedRolesAfterAdminSet(storedRoles: unknown, target: string): string[] {
  const stored = Array.isArray(storedRoles) ? storedRoles.filter((r): r is string => typeof r === 'string') : [];
  if (target === 'admin') return stored.includes('admin') ? stored : [...stored, 'admin'];
  return stored.filter((r) => r !== 'admin');
}

/**
 * Сменить роль внутри транзакции вызывающего. NULL — человека нет.
 * Отказ любого шага бросается: вызывающий откатывает транзакцию.
 */
export async function applyAdminRoleChange(
  db: Db,
  userId: string,
  role: string,
  actorId: string,
): Promise<AdminRoleChange | null> {
  const { rows } = await db.query<{ role: string; preferences: { roles?: unknown } | null }>(
    `SELECT role, preferences FROM users WHERE id = $1 FOR UPDATE`,
    [userId],
  );
  const user = rows[0];
  if (!user) return null;

  const ownedAdminBefore = ownedRoles(user.preferences?.roles, user.role).includes('admin');
  const nextRoles = ownedRolesAfterAdminSet(user.preferences?.roles, role);

  await db.query(
    `UPDATE users
        SET role = $2,
            preferences = jsonb_set(
              CASE WHEN jsonb_typeof(preferences) = 'object' THEN preferences ELSE '{}'::jsonb END,
              '{roles}', $3::jsonb),
            updated_at = NOW()
      WHERE id = $1`,
    [userId, role, JSON.stringify(nextRoles)],
  );

  let sessionsRevoked = 0;
  if (ownedAdminBefore && role !== 'admin') {
    const revoked = await db.query(`DELETE FROM user_sessions WHERE user_id = $1`, [userId]);
    sessionsRevoked = revoked.rowCount ?? 0;
  }

  await db.query(
    `INSERT INTO audit_log (entity_type, entity_id, action, data, created_at)
     VALUES ('user', $1, 'role_change', $2::jsonb, NOW())`,
    [userId, JSON.stringify({ role, from: user.role, changedBy: actorId, sessions_revoked: sessionsRevoked })],
  );

  return { previousRole: user.role, ownedAdminBefore, sessionsRevoked };
}
