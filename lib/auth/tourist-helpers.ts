/**
 * Tourist System Helper Functions
 * Provides utilities for tourist operations
 */

import { query } from '@/lib/database';

/**
 * Get or create tourist profile
 */
export async function getTouristProfile(userId: string): Promise<Record<string, unknown> | null> {
  try {
    let result = await query(
      `SELECT id, user_id, full_name, total_trips, total_spent, loyalty_points, created_at, updated_at FROM tourist_profiles WHERE user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      const userResult = await query(
        `SELECT name, email FROM users WHERE id = $1`,
        [userId]
      );

      if (userResult.rows.length === 0) {
        return null;
      }

      result = await query(
        `INSERT INTO tourist_profiles (user_id, full_name)
         VALUES ($1, $2)
         RETURNING *`,
        [userId, userResult.rows[0].name]
      );
    }

    return result.rows[0];
  } catch (error) {
    return null;
  }
}

/**
 * Get expiring documents
 */
export async function getExpiringDocuments(userId: string, daysBeforeExpiry: number = 30): Promise<Record<string, unknown>[]> {
  try {
    const profile = await getTouristProfile(userId);
    if (!profile) return [];
    // Приведение к целому — не защита (защита в параметризации), а честность
    // типа: дробный или нечисловой срок означал бы, что вызывающий имел в
    // виду что-то другое, и тихо считать его нулём хуже, чем считать нулём явно.
    const days = Number.isFinite(daysBeforeExpiry) ? Math.trunc(daysBeforeExpiry) : 30;

    const result = await query(
      `SELECT id, tourist_id, document_type, document_number, issuing_country, issuing_authority,
              issue_date, expiry_date, file_url, file_name, file_size, notes, reminder_sent, created_at, updated_at
       FROM tourist_documents
       WHERE tourist_id = $1
         AND expiry_date IS NOT NULL
         -- Срок приходит ПАРАМЕТРОМ, а не склейкой строки.
         --
         -- Интервал собирался конкатенацией из значения аргумента: сегодня
         -- сюда приходит число из умолчания, но функция публичная, и первый
         -- же вызов из API с query-параметром сделал бы это инъекцией. У
         -- Postgres интервал умножается на число — параметризовать можно,
         -- и обходить правило «только $1, $2» было незачем.
         AND expiry_date <= CURRENT_DATE + (INTERVAL '1 day' * $2)
         AND expiry_date > CURRENT_DATE
         AND reminder_sent = FALSE
       ORDER BY expiry_date ASC`,
      [profile.id, days]
    );

    return result.rows;
  } catch (error) {
    return [];
  }
}

/**
 * Mark document reminder as sent
 */
export async function markDocumentReminderSent(documentId: string): Promise<void> {
  try {
    await query(
      `UPDATE tourist_documents SET reminder_sent = TRUE WHERE id = $1`,
      [documentId]
    );
  } catch (error) {
  }
}

// getTouristRecommendations и getUpcomingTripsWithReminders убраны 22.08.2026.
//
// Первая — ЧЕТВЁРТЫЙ движок подбора туров: платформа держит ровно три
// (lead-processor, lib/planner, lib/search), и правило прямо запрещает
// заводить новый вместо расширения существующего.
//
// Вторая собирала ближайшие поездки с напоминаниями и не звалась: напоминания
// о туре шлёт крон tour-reminder, о документах — document-expiry.

// Скидки по уровню лояльности здесь нет.
//
// `calculateLoyaltyDiscount` держала лестницу 0-5-10-15-20% и не звалась
// ниоткуда: точки применения к чеку не существует. Числа при этом выглядели
// как утверждённые — а решение о размере скидки принимает владелец, и
// принимается оно вместе с тем, кто её оплатит (для эко-скидок это уже
// сделано: lib/eco/compensation, реестр стоков и плательщик).
//
// Удалено 22.08.2026 (перепись). Появится программа лояльности — её условия
// лягут в реестр рядом с эко-стоками, а не константой в утилите профиля.

/**
 * getTouristTravelStats удалена 10.09.2026 вместе с updateTouristStats,
 * awardAchievement, checkTripAchievements и validateTripData: все они стояли
 * на tourist_trips / tourist_reviews / tourist_achievements — таблицах,
 * которых нет ни в одной миграции и не было на проде (issue #1771), а их
 * единственный читатель /api/tourist/trips не звался ни с одного экрана.
 * Сводка кабинета теперь — lib/tourist/cabinet (настоящие таблицы, тест на
 * настоящем PostgreSQL); эко-достижения — user_achievements, баллы — lib/eco.
 */

/**
 * Validate document data
 */
export function validateDocumentData(data: {
  documentType: string;
  documentNumber?: string;
  issueDate?: string;
  expiryDate?: string;
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  const validTypes = ['passport', 'visa', 'insurance', 'vaccination', 'permit', 'license', 'other'];
  if (!data.documentType || !validTypes.includes(data.documentType)) {
    errors.push('Укажите корректный тип документа');
  }

  if (data.issueDate && data.expiryDate) {
    const issueDate = new Date(data.issueDate);
    const expiryDate = new Date(data.expiryDate);

    if (expiryDate <= issueDate) {
      errors.push('Дата окончания действия должна быть позже даты выдачи');
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
