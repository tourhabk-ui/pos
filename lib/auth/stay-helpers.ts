/**
 * Stay (accommodation) Helper Functions
 * Утилиты для владельцев жилья: партнёр category='stay'.
 */

import { query } from '@/lib/database';

/**
 * Партнёрский профиль владельца жилья по user_id.
 */
export async function getStayPartnerId(userId: string): Promise<string | null> {
  try {
    const result = await query(
      `SELECT id FROM partners
       WHERE user_id = $1 AND category = 'stay'
       LIMIT 1`,
      [userId]
    );

    return (result.rows[0]?.id as string | undefined) ?? null;
  } catch (error) {
    return null;
  }
}

/**
 * Проверка владения объектом размещения.
 */
export async function verifyAccommodationOwnership(userId: string, accommodationId: string): Promise<boolean> {
  try {
    const result = await query(
      `SELECT a.id
       FROM accommodations a
       JOIN partners p ON a.partner_id = p.id
       WHERE p.user_id = $1 AND p.category = 'stay' AND a.id = $2`,
      [userId, accommodationId]
    );

    return result.rows.length > 0;
  } catch (error) {
    return false;
  }
}
