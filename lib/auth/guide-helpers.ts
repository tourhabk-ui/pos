/**
 * Guide Helper Functions
 * Utilities for working with guide profiles, schedules, and business logic
 */

import { query } from '@/lib/database';
import { ensurePartnerForRole } from '@/lib/auth/partner-profile';
import { logGuideFailure } from '@/lib/guides/db-failure';

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

/** Профиль гида, как его видит кабинет. `null` в поле — «не записано», не ноль. */
export interface GuidePartnerProfile {
  id: string;
  name: string;
  description: string | null;
  contact: Record<string, unknown> | null;
  /** Средняя оценка; null, пока отзывов нет (0.0 по умолчанию колонки — не оценка). */
  rating: number | null;
  reviewCount: number;
  isVerified: boolean;
  logoUrl: string | null;
  experienceYears: number | null;
  languages: string[];
  specializations: string[];
  location: { lat: number; lng: number } | null;
  isAvailable: boolean | null;
  profileStatus: string;
  profileReviewComment: string | null;
  onboardingCompleted: boolean;
  createdAt: string;
  updatedAt: string;
}

function readLocation(raw: unknown): { lat: number; lng: number } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const lat = Number(o.lat);
  const lng = Number(o.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/**
 * Профиль гида по пользователю. `null` — записи гида нет.
 *
 * Прежняя версия выбирала `p.bio` и `p.total_earnings` (таких колонок нет) и
 * `ST_X(p.location::geometry)` (PostGIS в базе нет, `location` — jsonb), а
 * пустой catch превращал 42703 в `null`. Для PUT профиля это значило
 * «профиля нет» при КАЖДОМ сохранении — и падение на `partner!.id` после уже
 * записанного имени. Отказ базы теперь бросается дальше: «профиля нет» и
 * «не смогли спросить» — разные ответы.
 */
export async function getGuidePartnerByUserId(userId: string): Promise<GuidePartnerProfile | null> {
  let result;
  try {
    result = await query(
      `SELECT
        p.id, p.name, p.description, p.contact, p.rating, p.review_count,
        p.is_verified, p.experience_years, p.languages, p.specializations,
        p.location, p.is_available, p.profile_status, p.profile_review_comment,
        p.onboarding_completed, p.created_at, p.updated_at,
        a.url AS logo_url
      FROM partners p
      LEFT JOIN assets a ON p.logo_asset_id = a.id
      WHERE p.user_id = $1 AND p.category = 'guide'
      LIMIT 1`,
      [userId]
    );
  } catch (error) {
    logGuideFailure('getGuidePartnerByUserId', error);
    throw error;
  }

  const row = result.rows[0];
  if (!row) return null;

  const reviewCount = Number(row.review_count ?? 0);
  const rating = row.rating == null ? null : Number(row.rating);
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    description: (row.description as string | null) ?? null,
    contact: (row.contact as Record<string, unknown> | null) ?? null,
    rating: reviewCount > 0 && rating !== null && Number.isFinite(rating) ? rating : null,
    reviewCount,
    isVerified: row.is_verified === true,
    logoUrl: (row.logo_url as string | null) ?? null,
    experienceYears: row.experience_years == null ? null : Number(row.experience_years),
    languages: Array.isArray(row.languages) ? (row.languages as string[]) : [],
    specializations: Array.isArray(row.specializations) ? (row.specializations as string[]) : [],
    location: readLocation(row.location),
    isAvailable: typeof row.is_available === 'boolean' ? row.is_available : null,
    profileStatus: String(row.profile_status ?? 'none'),
    profileReviewComment: (row.profile_review_comment as string | null) ?? null,
    onboardingCompleted: row.onboarding_completed === true,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Запись гида для пользователя С РОЛЬЮ ГИДА; создаёт, если её нет.
 *
 * Делегирует `ensurePartnerForRole` — единственному месту, где партнёрская
 * запись создаётся по роли (с защитой от гонки). Прежняя копия вставляла без
 * NOT EXISTS и звалась и для администратора: админ, открывший экран профиля
 * гида, получал лишнюю запись `category='guide'`. Кто может звать — решает
 * вызывающий; здесь только гид.
 */
export async function ensureGuidePartnerExists(userId: string): Promise<string | null> {
  try {
    return await ensurePartnerForRole(userId, 'guide');
  } catch (error) {
    logGuideFailure('ensureGuidePartnerExists', error);
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
    // «Не ваш отзыв» и «не смогли спросить» снаружи одинаковы (404), но
    // второе обязано остаться в логе.
    logGuideFailure('verifyReviewOwnership', error);
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

/** Сводка кабинета гида. `null` в числе — «данных нет», а не ноль. */
export interface GuideStats {
  tours: { completed: number; scheduled: number; active: number };
  upcoming: number;
  reviews: { total: number; avgRating: number | null };
  earnings: {
    /** Строк начислений (без отменённых). 0 — начислений не было вовсе. */
    count: number;
    totalPaid: number | null;
    pending: number | null;
    monthlyTrends: Array<{ month: string; toursCount: number; earnings: number }>;
  };
  certifications: { verified: number };
}

/**
 * Статистика гида.
 *
 * Прежний запрос соединял schedule, reviews, earnings и certifications
 * LEFT JOIN-ами в одну строку: каждое начисление размножалось на число
 * отзывов и сертификатов, и SUM(amount) вырастал кратно. «Будущие» туры
 * сравнивали `start_time` (time) с NOW() (timestamptz) — 42883, запрос не
 * выполнялся вовсе, а пустой catch отдавал `null`. Статусы заработка читались
 * из `status`, тогда как экран заработка — из `payment_status`.
 *
 * Теперь каждая таблица — своим подзапросом, «будущее» — это
 * `tour_date + start_time` по камчатскому времени, статус заработка один —
 * `payment_status` (у него CHECK pending/paid/cancelled), отменённое в суммы
 * не идёт. `null` — гида нет; отказ базы логируется и бросается.
 */
export async function getGuideStats(userId: string): Promise<GuideStats | null> {
  const guideId = await getGuidePartnerId(userId);
  if (!guideId) return null;

  try {
    const statsResult = await query(
      `SELECT
        (SELECT COUNT(*) FROM guide_schedule WHERE guide_id = $1 AND status = 'completed')   AS completed_tours,
        (SELECT COUNT(*) FROM guide_schedule WHERE guide_id = $1 AND status = 'scheduled')   AS scheduled_tours,
        (SELECT COUNT(*) FROM guide_schedule WHERE guide_id = $1 AND status = 'in_progress') AS active_tours,
        (SELECT COUNT(*) FROM guide_schedule
          WHERE guide_id = $1 AND status = 'scheduled'
            AND (tour_date + start_time) > (NOW() AT TIME ZONE 'Asia/Kamchatka'))           AS upcoming_tours,
        (SELECT COUNT(*) FROM guide_reviews WHERE guide_id = $1 AND is_public = TRUE)        AS total_reviews,
        (SELECT AVG(rating) FROM guide_reviews WHERE guide_id = $1 AND is_public = TRUE)     AS avg_rating,
        (SELECT COUNT(*) FROM guide_earnings
          WHERE guide_id = $1 AND payment_status IS DISTINCT FROM 'cancelled')                             AS earnings_count,
        (SELECT COALESCE(SUM(amount), 0) FROM guide_earnings
          WHERE guide_id = $1 AND payment_status = 'paid')                                   AS total_paid,
        (SELECT COALESCE(SUM(amount), 0) FROM guide_earnings
          WHERE guide_id = $1 AND payment_status = 'pending')                                AS total_pending,
        (SELECT COUNT(*) FROM guide_certifications
          WHERE guide_id = $1 AND is_verified = TRUE)                                        AS verified_certs`,
      [guideId]
    );
    const st = statsResult.rows[0] ?? {};

    const trendsResult = await query(
      `SELECT
        to_char(DATE_TRUNC('month', COALESCE(date, payment_date, created_at::date)), 'YYYY-MM') AS month,
        COUNT(*) AS tours_count,
        SUM(amount) AS earnings
      FROM guide_earnings
      WHERE guide_id = $1
        AND payment_status = 'paid'
        AND COALESCE(date, payment_date, created_at::date) >= CURRENT_DATE - INTERVAL '6 months'
      GROUP BY 1
      ORDER BY 1 ASC`,
      [guideId]
    );

    const earningsCount = Number(st.earnings_count ?? 0);
    const reviewsTotal = Number(st.total_reviews ?? 0);
    return {
      tours: {
        completed: Number(st.completed_tours ?? 0),
        scheduled: Number(st.scheduled_tours ?? 0),
        active: Number(st.active_tours ?? 0),
      },
      upcoming: Number(st.upcoming_tours ?? 0),
      reviews: {
        total: reviewsTotal,
        avgRating: reviewsTotal > 0 && st.avg_rating != null ? Number(st.avg_rating) : null,
      },
      earnings: {
        count: earningsCount,
        totalPaid: earningsCount > 0 ? Number(st.total_paid ?? 0) : null,
        pending: earningsCount > 0 ? Number(st.total_pending ?? 0) : null,
        monthlyTrends: trendsResult.rows.map((row) => ({
          month: String(row.month),
          toursCount: Number(row.tours_count ?? 0),
          earnings: Number(row.earnings ?? 0),
        })),
      },
      certifications: { verified: Number(st.verified_certs ?? 0) },
    };
  } catch (error) {
    logGuideFailure('getGuideStats', error);
    throw error;
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
