/**
 * Партнёрский профиль по роли пользователя.
 * Всё партнёрское на платформе связано через partners.user_id + category,
 * поэтому назначение партнёрской роли без записи в partners оставляет
 * кабинет пустым. Используется при смене роли (POST /api/roles,
 * PATCH /api/admin/users/[id]).
 */

import { query } from '@/lib/database';
import { PARTNER_ROLES } from '@/lib/auth/role-routes';

const PARTNER_ROLE_SET = new Set<string>(PARTNER_ROLES);

/**
 * Гарантирует партнёрский профиль для партнёрской роли.
 * Для непартнёрских ролей (tourist, admin, user) — no-op.
 * Возвращает id профиля или null.
 */
export async function ensurePartnerForRole(userId: string, role: string): Promise<string | null> {
  if (!PARTNER_ROLE_SET.has(role)) return null;

  const existing = await query(
    `SELECT id FROM partners WHERE user_id = $1 AND category = $2 LIMIT 1`,
    [userId, role]
  );
  if (existing.rows.length > 0) {
    return existing.rows[0].id as string;
  }

  const userResult = await query<{ name: string; email: string }>(
    'SELECT name, email FROM users WHERE id = $1',
    [userId]
  );
  if (userResult.rows.length === 0) return null;
  const { name, email } = userResult.rows[0];

  const inserted = await query(
    `INSERT INTO partners (user_id, name, category, contact, is_verified, rating, review_count, created_at, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, false, 0, 0, NOW(), NOW())
     RETURNING id`,
    [userId, name, role, JSON.stringify({ email })]
  );

  return (inserted.rows[0]?.id as string | undefined) ?? null;
}
