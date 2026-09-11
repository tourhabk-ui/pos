/**
 * Operator Helper Functions
 * Utilities for working with operator role and partner records
 */

import { query } from '@/lib/database';

/**
 * След неудавшейся проверки.
 *
 * Все проверки в этом файле fail-closed: сбой — отказ в доступе, а не выдача
 * прав. Направление верное, но молчали они одинаково с «прав нет», и разобрать
 * жалобу оператора «не вижу свою бронь» было не по чему. §4.0: ловить можно,
 * молчать нельзя — имя проверки и SQLSTATE в лог.
 */
function logCheckFailure(check: string, error: unknown): void {
  const code = (error as { code?: string } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[operator-helpers] ${check}: отказ проверки${code ? ` SQLSTATE ${code}` : ''} — ${message}`);
}


/**
 * Get partner ID for an operator user
 * Returns partner.id linked to user.id
 */
export async function getOperatorPartnerId(userId: string): Promise<string | null> {
  try {
    const result = await query(
      `SELECT id FROM partners 
       WHERE user_id = $1 AND category = 'operator'
       LIMIT 1`,
      [userId]
    );
    
    if (result.rows.length > 0) {
      return result.rows[0].id as string;
    }
    
    // Auto-create partner profile if missing
    const userResult = await query(
      `SELECT name, email FROM users WHERE id = $1`,
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return null;
    }
    
    const user = userResult.rows[0];
    const contact = {
      email: user.email || '',
      phone: '',
    };
    
    const partnerResult = await query(
      `INSERT INTO partners (user_id, name, category, contact, is_verified, rating, review_count)
       VALUES ($1, $2, 'operator', $3, FALSE, 0, 0)
       RETURNING id`,
      [userId, user.name || 'Оператор', JSON.stringify(contact)]
    );
    
    return (partnerResult.rows[0]?.id as string | undefined) ?? null;
  } catch (error) {
    logCheckFailure('getOperatorPartnerId', error);
    return null;
  }
}

// Здесь больше нет getGuidePartnerId и getTransferPartnerId.
//
// Это были ТОЧНЫЕ копии живых функций из lib/auth/guide-helpers.ts и
// lib/auth/transfer-helpers.ts — сверено построчно, различался только
// комментарий у соседа. Зовут те, копии не звал никто, и стоило одной из трёх
// разойтись с остальными — расхождение проявилось бы как «прав нет» у того,
// у кого они есть. Удалены 22.08.2026 (перепись).

// getPartnerByUserId и ensurePartnerExists удалены 11.09 (#1803) вместе со
// своими единственными вызывающими — роутами /api/operator/profile и
// /api/operator/profile/settings, которые отвечали 500 на несуществующем
// operator_settings.id и не были подключены ни к одному экрану. Живой путь
// кабинета — /api/hub/operator/profile поверх getOperatorPartnerId;
// автосоздание профиля делает lib/auth/partner-profile.ts в транзакции
// регистрации (случай 24.08). Экспорт без вызывающего — лишнее слово export.

/**
 * Verify user owns a tour (through partner)
 */
export async function verifyTourOwnership(userId: string, tourId: string): Promise<boolean> {
  try {
    const result = await query(
      `SELECT t.id
       FROM operator_tours t
       JOIN partners p ON t.operator_id = p.id
       WHERE p.user_id = $1 AND t.id = $2 AND t.deleted_at IS NULL`,
      [userId, tourId]
    );
    
    return result.rows.length > 0;
  } catch (error) {
    logCheckFailure('verifyTourOwnership', error);
    return false;
  }
}

/**
 * Verify user owns a booking (through tour -> partner)
 */
export async function verifyBookingOwnership(userId: string, bookingId: string): Promise<boolean> {
  try {
    const result = await query(
      `SELECT b.id
       FROM operator_bookings b
       JOIN operator_tours t ON b.operator_tour_id = t.id
       JOIN partners p ON t.operator_id = p.id
       WHERE p.user_id = $1 AND b.id = $2 AND b.deleted_at IS NULL AND t.deleted_at IS NULL`,
      [userId, bookingId]
    );
    
    return result.rows.length > 0;
  } catch (error) {
    logCheckFailure('verifyBookingOwnership', error);
    return false;
  }
}

interface OperatorStats {
  totalTours: number;
  activeTours: number;
  totalBookings: number;
  totalRevenue: number;
  avgRating: number;
  totalReviews: number;
  completionRate: number;
}

// getOperatorStats убрана 22.08.2026 (перепись): читала кэш-таблицу
// operator_stats_cache и не звалась. Кабинет оператора считает свои цифры
// запросами по месту.
