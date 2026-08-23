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

/**
 * Get partner record with full details
 */
export async function getPartnerByUserId(userId: string, category?: string): Promise<any | null> {
  try {
    let queryStr = `
      SELECT 
        p.id,
        p.name,
        p.category,
        p.description,
        p.contact,
        p.rating,
        p.review_count,
        p.is_verified,
        p.logo_asset_id,
        p.created_at,
        p.updated_at,
        a.url as logo_url
      FROM partners p
      LEFT JOIN assets a ON p.logo_asset_id = a.id
      WHERE p.user_id = $1
    `;
    
    const params = [userId];
    
    if (category) {
      queryStr += ` AND p.category = $2`;
      params.push(category);
    }
    
    queryStr += ` LIMIT 1`;
    
    const result = await query(queryStr, params);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const partner = result.rows[0];
    return {
      id: partner.id,
      name: partner.name,
      category: partner.category,
      description: partner.description,
      contact: partner.contact,
      rating: parseFloat(partner.rating as string),
      reviewCount: partner.review_count,
      isVerified: partner.is_verified,
      logoAssetId: partner.logo_asset_id,
      logoUrl: partner.logo_url,
      createdAt: partner.created_at,
      updatedAt: partner.updated_at
    };
  } catch (error) {
    logCheckFailure('getPartnerByUserId', error);
    return null;
  }
}

/**
 * Create partner record for user if doesn't exist
 */
export async function ensurePartnerExists(userId: string, userName: string, userEmail: string, role: string): Promise<string> {
  try {
    // Map role to category
    const categoryMap: Record<string, string> = {
      'operator': 'operator',
      'guide': 'guide',
      'transfer': 'transfer',
      'agent': 'operator' // agents work as operators
    };

    const category = categoryMap[role] || 'operator';

    // Ищем запись ИМЕННО этой категории, а не первую попавшуюся.
    //
    // Один человек может оказывать несколько услуг: физлицо с экскурсиями и
    // трансфером — обычный камчатский случай, и у него две записи в partners
    // под одним user_id. Прежний запрос `WHERE user_id = $1 LIMIT 1` возвращал
    // произвольную из них: кабинет оператора мог получить трансферную запись и
    // показать чужие туры. Сортировка по created_at делает выбор ещё и
    // повторяемым, если дублей одной категории окажется несколько.
    const existing = await query(
      `SELECT id FROM partners
        WHERE user_id = $1 AND category = $2
        ORDER BY created_at ASC
        LIMIT 1`,
      [userId, category]
    );

    if (existing.rows.length > 0) {
      return existing.rows[0].id as string;
    }

    // Create new partner record
    const result = await query(
      `INSERT INTO partners (user_id, name, category, contact, is_verified, rating, review_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        userId,
        userName,
        category,
        JSON.stringify({ email: userEmail, phone: '' }),
        false,
        0.0,
        0
      ]
    );
    
    return result.rows[0].id as string;
  } catch (error) {
    throw error;
  }
}

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
