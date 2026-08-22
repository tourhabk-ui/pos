/**
 * Guide Helper Functions
 * Utilities for working with guide profiles, schedules, and business logic
 */

import { query } from '@/lib/database';

/**
 * Get partner ID for a guide user
 * Returns partner.id linked to user.id where category='guide'
 */
export async function getGuidePartnerId(userId: string): Promise<string | null> {
  try {
    const result = await query(
      `SELECT id FROM partners 
       WHERE user_id = $1 AND category = 'guide'
       LIMIT 1`,
      [userId]
    );
    
    return (result.rows[0]?.id as string | undefined) ?? null;
  } catch (error) {
    // `null` здесь значит «такой роли у пользователя нет», и вызывающие
    // читают его как отказ в правах. Отказ БАЗЫ выглядит точно так же —
    // человек с правами получает «нет прав», и причину не найти. Тип менять
    // нельзя, не тронув всех вызывающих, поэтому отказ хотя бы называется.
    console.error('[auth] getGuidePartnerId: запрос к partners не выполнился:',
      error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Get guide partner record with full details
 */
export async function getGuidePartnerByUserId(userId: string): Promise<Record<string, unknown> | null> {
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
        p.experience_years,
        p.languages,
        p.specializations,
        p.bio,
        ST_X(p.location::geometry) as longitude,
        ST_Y(p.location::geometry) as latitude,
        p.total_earnings,
        p.is_available,
        p.created_at,
        p.updated_at,
        a.url as logo_url
      FROM partners p
      LEFT JOIN assets a ON p.logo_asset_id = a.id
      WHERE p.user_id = $1 AND p.category = 'guide'
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
      experienceYears: partner.experience_years,
      languages: partner.languages,
      specializations: partner.specializations,
      bio: partner.bio,
      location: partner.latitude && partner.longitude ? {
        lat: parseFloat(partner.latitude as string),
        lng: parseFloat(partner.longitude as string)
      } : null,
      totalEarnings: parseFloat(String(partner.total_earnings ?? 0)),
      isAvailable: partner.is_available,
      createdAt: partner.created_at,
      updatedAt: partner.updated_at
    };
  } catch (error) {
    return null;
  }
}

/**
 * Create guide partner record for user if doesn't exist
 */
export async function ensureGuidePartnerExists(userId: string, userName: string, userEmail: string): Promise<string> {
  try {
    // Check if partner exists
    const existing = await query(
      `SELECT id FROM partners WHERE user_id = $1 AND category = 'guide' LIMIT 1`,
      [userId]
    );
    
    if (existing.rows.length > 0) {
      return existing.rows[0].id as string;
    }
    
    // Create new partner record
    const result = await query(
      `INSERT INTO partners (user_id, name, category, contact, is_verified, rating, review_count, is_available)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        userId,
        userName,
        'guide',
        JSON.stringify({ email: userEmail, phone: '' }),
        false,
        0.0,
        0,
        true
      ]
    );
    
    return result.rows[0].id as string;
  } catch (error) {
    throw error;
  }
}

/**
 * Verify user owns a schedule entry
 */
export async function verifyScheduleOwnership(userId: string, scheduleId: string): Promise<boolean> {
  try {
    const result = await query(
      `SELECT gs.id 
       FROM guide_schedule gs
       JOIN partners p ON gs.guide_id = p.id
       WHERE p.user_id = $1 AND gs.id = $2`,
      [userId, scheduleId]
    );
    
    return result.rows.length > 0;
  } catch (error) {
    return false;
  }
}

/**
 * Verify user owns a review (for replying)
 */
export async function verifyReviewOwnership(userId: string, reviewId: string): Promise<boolean> {
  try {
    const result = await query(
      `SELECT gr.id 
       FROM guide_reviews gr
       JOIN partners p ON gr.guide_id = p.id
       WHERE p.user_id = $1 AND gr.id = $2`,
      [userId, reviewId]
    );
    
    return result.rows.length > 0;
  } catch (error) {
    return false;
  }
}

/**
 * Check for schedule conflicts
 * Returns true if NO conflicts exist
 */
export async function checkScheduleConflicts(
  guideId: string,
  startTime: string,
  endTime: string,
  excludeId?: string
): Promise<boolean> {
  try {
    const params: (string | null)[] = [guideId, startTime, endTime];
    const paramIndex = 4;
    
    let queryStr = `
      SELECT check_schedule_conflicts($1, $2, $3`;
    
    if (excludeId) {
      queryStr += `, $${paramIndex}`;
      params.push(excludeId);
    } else {
      queryStr += `, NULL`;
    }
    
    queryStr += `) as no_conflicts`;
    
    const result = await query(queryStr, params);
    
    return result.rows[0]?.no_conflicts === true;
  } catch (error) {
    return false;
  }
}

export async function hasTourDayConflict(params: {
  guideId: string;
  tourId?: string | null;
  startTime?: string;
  excludeId?: string;
}): Promise<boolean> {
  const { guideId, tourId, startTime, excludeId } = params;

  if (!guideId || !tourId || !startTime) {
    return false;
  }

  try {
    const queryParams: (string | null)[] = [guideId, tourId, startTime];
    let queryStr = `
      SELECT 1
      FROM guide_schedule
      WHERE guide_id = $1
        AND tour_id = $2
        AND DATE(start_time) = DATE($3::timestamptz)
        AND status != 'cancelled'
    `;

    if (excludeId) {
      queryStr += ' AND id != $4';
      queryParams.push(excludeId);
    }

    queryStr += ' LIMIT 1';

    const result = await query(queryStr, queryParams);
    return result.rows.length > 0;
  } catch (error) {
    return false;
  }
}

// Расчёта и записи заработка гида здесь нет — и это не пропуск.
//
// `recordGuideEarnings` был написан против ПРИЗРАКА: schema.sql держал два
// объявления guide_earnings, применялось первое, а функция писала во второе —
// booking_id, date и status в настоящей таблице не существуют, первый же
// INSERT упал бы. Вызовов не было, поэтому расхождение жило незамеченным
// (перепись 22.08.2026; сторож — tests/unit/schema-single-declaration.test.ts).
//
// Экран заработка (app/api/guide/earnings) ЧИТАЕТ настоящую таблицу и ждёт
// писателя. Писатель проектируется вместе с выплатой — кто начисляет, при
// каком событии брони и по какой ставке; это решение владельца, а не утилита
// с ставкой 10% по умолчанию.

/**
 * Get guide statistics
 */
export async function getGuideStats(userId: string): Promise<Record<string, unknown> | null> {
  try {
    const guideId = await getGuidePartnerId(userId);
    
    if (!guideId) {
      return null;
    }
    
    // Overall stats
    const statsResult = await query(
      `SELECT 
        COUNT(DISTINCT gs.id) FILTER (WHERE gs.status = 'completed') as completed_tours,
        COUNT(DISTINCT gs.id) FILTER (WHERE gs.status = 'scheduled') as scheduled_tours,
        COUNT(DISTINCT gs.id) FILTER (WHERE gs.status = 'in_progress') as active_tours,
        COUNT(DISTINCT gr.id) as total_reviews,
        COALESCE(AVG(gr.rating), 0) as avg_rating,
        COALESCE(SUM(ge.amount) FILTER (WHERE ge.status = 'paid'), 0) as total_paid_earnings,
        COALESCE(SUM(ge.amount) FILTER (WHERE ge.status = 'pending'), 0) as pending_earnings,
        COUNT(DISTINCT gc.id) FILTER (WHERE gc.is_verified = true) as verified_certifications
      FROM partners p
      LEFT JOIN guide_schedule gs ON p.id = gs.guide_id
      LEFT JOIN guide_reviews gr ON p.id = gr.guide_id AND gr.is_public = true
      LEFT JOIN guide_earnings ge ON p.id = ge.guide_id
      LEFT JOIN guide_certifications gc ON p.id = gc.guide_id
      WHERE p.id = $1`,
      [guideId]
    );
    
    const stats = statsResult.rows[0];
    
    // Monthly earnings trend (last 6 months)
    const trendsResult = await query(
      `SELECT 
        DATE_TRUNC('month', date) as month,
        COUNT(*) as tours_count,
        SUM(amount) as earnings
      FROM guide_earnings
      WHERE guide_id = $1 
        AND date >= CURRENT_DATE - INTERVAL '6 months'
        AND status = 'paid'
      GROUP BY DATE_TRUNC('month', date)
      ORDER BY month ASC`,
      [guideId]
    );
    
    const monthlyTrends = trendsResult.rows.map(row => ({
      month: row.month,
      toursCount: parseInt(row.tours_count as string),
      earnings: parseFloat(String(row.earnings ?? 0))
    }));
    
    // Upcoming schedule
    const upcomingResult = await query(
      `SELECT COUNT(*) as count
       FROM guide_schedule
       WHERE guide_id = $1 
         AND start_time > NOW()
         AND status = 'scheduled'`,
      [guideId]
    );
    
    return {
      tours: {
        completed: parseInt(String(stats.completed_tours ?? 0)),
        scheduled: parseInt(String(stats.scheduled_tours ?? 0)),
        active: parseInt(String(stats.active_tours ?? 0))
      },
      reviews: {
        total: parseInt(String(stats.total_reviews ?? 0)),
        avgRating: parseFloat(String(stats.avg_rating ?? 0)).toFixed(2)
      },
      earnings: {
        totalPaid: parseFloat(String(stats.total_paid_earnings ?? 0)),
        pending: parseFloat(String(stats.pending_earnings ?? 0)),
        monthlyTrends
      },
      certifications: {
        verified: parseInt(String(stats.verified_certifications ?? 0))
      },
      upcoming: parseInt(String(upcomingResult.rows[0].count ?? 0))
    };
  } catch (error) {
    return null;
  }
}

// Подбора гида по расписанию здесь нет.
//
// Три функции (`getGuideAvailability`, `isGuideAvailable`, `findAvailableGuides`)
// читали guide_availability — таблицу, в которую НИКТО не пишет: ни экрана,
// ни импорта, ни API. Читатели пустоты гарантированно возвращали «гид
// недоступен» — и не звались ниоткуда (перепись 22.08.2026). Занятость гида
// сегодня живёт в guide_schedule с EXCLUDE-ограничением пересечений; подбор
// гида начнётся с формы, которой гид заполняет свои окна, а не с читателей.

/**
 * Get guide's expertise zones for map display
 */
export async function getGuideExpertiseZones(guideId: string): Promise<Record<string, unknown>[]> {
  try {
    // Get tours associated with this guide
    const result = await query(
      `SELECT DISTINCT
        t.id,
        t.title,
        ST_X(t.location::geometry) as longitude,
        ST_Y(t.location::geometry) as latitude,
        t.duration_hours AS duration,
        t.difficulty_level
      FROM operator_tours t
      WHERE t.guide_id = $1
        AND t.location IS NOT NULL
        AND t.deleted_at IS NULL
      ORDER BY t.title`,
      [guideId]
    );
    
    return result.rows.map(row => ({
      tourId: row.id,
      title: row.title,
      location: {
        lat: parseFloat(row.latitude as string),
        lng: parseFloat(row.longitude as string)
      },
      duration: row.duration,
      difficultyLevel: row.difficulty_level
    }));
  } catch (error) {
    return [];
  }
}
