/**
 * Gear Rental Helper Functions
 * Utilities for working with gear rental partners and equipment
 */

import { query } from '@/lib/database';

/**
 * Get partner ID for a gear rental user
 * Returns partner.id linked to user.id where category='gear'
 */
export async function getGearPartnerId(userId: string): Promise<string | null> {
  try {
    const result = await query(
      `SELECT id FROM partners 
       WHERE user_id = $1 AND category = 'gear'
       LIMIT 1`,
      [userId]
    );
    
    return (result.rows[0]?.id as string | undefined) ?? null;
  } catch (error) {
    return null;
  }
}

/**
 * Get gear partner record with full details
 */
export async function getGearPartnerByUserId(userId: string): Promise<Record<string, unknown> | null> {
  try {
    const result = await query(
      `SELECT 
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
      WHERE p.user_id = $1 AND p.category = 'gear'
      LIMIT 1`,
      [userId]
    );
    
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
    return null;
  }
}

/**
 * Create gear partner record for user if doesn't exist
 */
export async function ensureGearPartnerExists(userId: string, userName: string, userEmail: string): Promise<string> {
  try {
    // Check if partner exists
    const existing = await query(
      `SELECT id FROM partners WHERE user_id = $1 AND category = 'gear' LIMIT 1`,
      [userId]
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
        'gear',
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
 * Verify user owns a gear item
 */
export async function verifyGearItemOwnership(userId: string, gearItemId: string): Promise<boolean> {
  try {
    const result = await query(
      `SELECT gi.id 
       FROM gear_items gi
       JOIN partners p ON gi.partner_id = p.id
       WHERE p.user_id = $1 AND gi.id = $2`,
      [userId, gearItemId]
    );
    
    return result.rows.length > 0;
  } catch (error) {
    return false;
  }
}

/**
 * Verify user owns a rental
 */
export async function verifyGearRentalOwnership(userId: string, rentalId: string): Promise<boolean> {
  try {
    const result = await query(
      `SELECT gr.id
       FROM gear_rentals gr
       JOIN gear_items gi ON gr.gear_id = gi.id
       JOIN partners p ON gi.partner_id = p.id
       WHERE p.user_id = $1 AND gr.id = $2`,
      [userId, rentalId]
    );
    
    return result.rows.length > 0;
  } catch (error) {
    return false;
  }
}

// checkGearAvailability / calculateRentalCost / updateGearAvailability удалены:
// они опирались на календарь gear_availability, который никто не заполнял, и не
// имели ни одного вызова. Доступность по датам теперь считается честно — пиком
// пересекающихся аренд прямо из gear_rentals (POST /api/gear/rentals и
// findAvailableGear ниже), цена — единым модулем lib/gear/pricing.

/**
 * Get gear partner statistics
 */
export async function getGearStats(userId: string): Promise<Record<string, unknown> | null> {
  try {
    const partnerId = await getGearPartnerId(userId);
    
    if (!partnerId) {
      return null;
    }
    
    // Overall stats. Аренды связаны с партнёром через gear_items (у gear_rentals
    // нет partner_id), выручка — из total_price выданных/завершённых аренд:
    // отдельного трекинга оплат по снаряжению нет, честнее считать по факту выдачи.
    const statsResult = await query(
      `SELECT
        (SELECT COUNT(*) FROM gear_items WHERE partner_id = $1) as total_items,
        (SELECT COUNT(*) FROM gear_items WHERE partner_id = $1 AND is_active = true) as active_items,
        (SELECT COALESCE(SUM(review_count), 0) FROM gear_items WHERE partner_id = $1) as total_reviews,
        (SELECT COALESCE(AVG(rating) FILTER (WHERE review_count > 0), 0) FROM gear_items WHERE partner_id = $1) as avg_rating,
        COUNT(gr.id) as total_rentals,
        COUNT(gr.id) FILTER (WHERE gr.status = 'active') as active_rentals,
        COUNT(gr.id) FILTER (WHERE gr.status = 'completed') as completed_rentals,
        COUNT(gr.id) FILTER (WHERE gr.status = 'pending') as pending_rentals,
        COALESCE(SUM(gr.total_price) FILTER (WHERE gr.status IN ('active', 'completed', 'overdue')), 0) as total_revenue
      FROM gear_rentals gr
      JOIN gear_items gi ON gr.gear_id = gi.id
      WHERE gi.partner_id = $1`,
      [partnerId]
    );

    const stats = statsResult.rows[0];

    // Monthly revenue trend (last 6 months)
    const trendsResult = await query(
      `SELECT
        DATE_TRUNC('month', gr.created_at) as month,
        COUNT(*) as rentals_count,
        COALESCE(SUM(gr.total_price) FILTER (WHERE gr.status IN ('active', 'completed', 'overdue')), 0) as revenue
      FROM gear_rentals gr
      JOIN gear_items gi ON gr.gear_id = gi.id
      WHERE gi.partner_id = $1
        AND gr.status <> 'cancelled'
        AND gr.created_at >= CURRENT_DATE - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', gr.created_at)
      ORDER BY month ASC`,
      [partnerId]
    );
    
    const monthlyTrends = trendsResult.rows.map(row => ({
      month: row.month,
      rentalsCount: parseInt(row.rentals_count as string),
      revenue: parseFloat(String(row.revenue ?? 0))
    }));
    
    // Top rented items
    const topItemsResult = await query(
      `SELECT 
        id,
        name,
        category,
        rental_count,
        total_revenue,
        rating
      FROM gear_items
      WHERE partner_id = $1 AND is_active = true
      ORDER BY rental_count DESC, total_revenue DESC
      LIMIT 5`,
      [partnerId]
    );
    
    const topItems = topItemsResult.rows.map(row => ({
      id: row.id,
      name: row.name,
      category: row.category,
      rentalCount: row.rental_count,
      totalRevenue: parseFloat(String(row.total_revenue ?? 0)),
      rating: parseFloat(String(row.rating ?? 0))
    }));
    
    return {
      items: {
        total: parseInt(String(stats.total_items ?? 0)),
        active: parseInt(String(stats.active_items ?? 0))
      },
      rentals: {
        total: parseInt(String(stats.total_rentals ?? 0)),
        active: parseInt(String(stats.active_rentals ?? 0)),
        completed: parseInt(String(stats.completed_rentals ?? 0)),
        pending: parseInt(String(stats.pending_rentals ?? 0))
      },
      revenue: {
        total: parseFloat(String(stats.total_revenue ?? 0)),
        monthlyTrends
      },
      reviews: {
        total: parseInt(String(stats.total_reviews ?? 0)),
        avgRating: parseFloat(String(stats.avg_rating ?? 0)).toFixed(2)
      },
      topItems
    };
  } catch (error) {
    return null;
  }
}

/**
 * Find available gear items
 */
export async function findAvailableGear(
  category?: string,
  startDate?: string,
  endDate?: string,
  minPrice?: number,
  maxPrice?: number,
  tags?: string[]
): Promise<Record<string, unknown>[]> {
  try {
    let queryStr = `
      SELECT
        gi.id,
        gi.name,
        gi.description,
        gi.category,
        gi.subcategory,
        gi.brand,
        gi.price_per_day,
        gi.price_per_week,
        gi.price_per_month,
        gi.deposit_amount,
        gi.insurance_cost_per_day,
        gi.images,
        gi.condition,
        gi.available_quantity,
        gi.rating,
        gi.review_count,
        p.name as partner_name,
        p.rating as partner_rating
      FROM gear_items gi
      JOIN partners p ON gi.partner_id = p.id
      WHERE gi.is_active = true
        AND gi.available_quantity > 0
    `;
    
    const params: (string | number | null | string[])[] = [];
    let paramIndex = 1;
    
    if (category) {
      queryStr += ` AND gi.category = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }
    
    if (minPrice !== undefined) {
      queryStr += ` AND gi.price_per_day >= $${paramIndex}`;
      params.push(minPrice);
      paramIndex++;
    }
    
    if (maxPrice !== undefined) {
      queryStr += ` AND gi.price_per_day <= $${paramIndex}`;
      params.push(maxPrice);
      paramIndex++;
    }
    
    if (tags && tags.length > 0) {
      queryStr += ` AND gi.tags && $${paramIndex}`;
      params.push(tags);
      paramIndex++;
    }
    
    // Доступность по датам — честно, из пересечения живых аренд, а не из
    // календаря gear_availability, который никто не заполнял (проверка по нему
    // была вечным «всё свободно»). Позиция скрывается, если в КАЖДЫЙ из дней
    // окна пик занятых единиц выбирает весь сток... точнее: если есть хотя бы
    // один день, где занят весь сток, — позицию не предлагаем на эти даты.
    if (startDate && endDate) {
      queryStr += `
        AND NOT EXISTS (
          SELECT 1
          FROM generate_series($${paramIndex}::date, $${paramIndex + 1}::date - 1, '1 day') AS d(day)
          JOIN gear_rentals gr
            ON gr.gear_id = gi.id
           AND gr.status IN ('pending', 'confirmed', 'active', 'overdue')
           AND gr.start_date <= d.day
           AND gr.end_date > d.day
          GROUP BY d.day
          HAVING SUM(gr.quantity) >= gi.quantity
        )
      `;
      params.push(startDate, endDate);
      paramIndex += 2;
    }
    
    queryStr += ` ORDER BY gi.rating DESC, gi.review_count DESC LIMIT 50`;
    
    const result = await query(queryStr, params);
    
    return result.rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      category: row.category,
      subcategory: row.subcategory,
      brand: row.brand,
      pricePerDay: parseFloat(row.price_per_day as string),
      pricePerWeek: row.price_per_week ? parseFloat(row.price_per_week as string) : null,
      pricePerMonth: row.price_per_month ? parseFloat(row.price_per_month as string) : null,
      depositAmount: row.deposit_amount ? parseFloat(row.deposit_amount as string) : null,
      insurancePerDay: row.insurance_cost_per_day ? parseFloat(row.insurance_cost_per_day as string) : null,
      images: row.images,
      condition: row.condition,
      availableQuantity: row.available_quantity,
      rating: parseFloat(row.rating as string),
      reviewCount: row.review_count,
      partnerName: row.partner_name,
      partnerRating: parseFloat(row.partner_rating as string)
    }));
  } catch (error) {
    return [];
  }
}
