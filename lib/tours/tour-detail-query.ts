/**
 * Чтение тура для карточки — ОДИН запрос на обе страницы
 * (`/catalog/tours/[id]` и `/marketplace/tours/[id]`).
 *
 * Зачем общий модуль: копии одного SQL в двух файлах уже разъезжались — на
 * проде это выглядело как «в каталоге одна карточка, в маркетплейсе другая».
 * Стандарт карточки (CLAUDE.md §11) требует единственной реализации; запрос —
 * её часть.
 *
 * Устойчивость к отставшей миграции. `start.js` применяет миграции, но НЕ роняет
 * деплой, если какая-то упала (падение пишется в `_migration_failures`). Значит
 * возможен момент, когда новый код уже раздаётся, а колонок из свежей миграции
 * (`program`, `safety_notes` — 809) в базе ещё нет. Раньше это давало
 * `column does not exist` → `catch` → `notFound()` → турист видел 404 на живом
 * туре. Теперь при такой ошибке повторяем запрос без новых колонок: карточка
 * покажется без программы дня и правил — но покажется.
 */

import { pool } from '@/lib/db-pool';

/** Строка тура для карточки. `program`/`safety_notes` могут отсутствовать,
 *  если миграция 809 ещё не применилась — карточка это переживает. */
export interface TourCardRow {
  id: number;
  title: string;
  description: string | null;
  short_description: string | null;
  base_price: string;
  price_old: string | null;
  price_unit: string | null;
  activity_type: string;
  location_type: string;
  location_name: string | null;
  latitude: string | null;
  longitude: string | null;
  meeting_point: string | null;
  tour_image: string | null;
  photos: string[] | null;
  max_participants: number;
  min_participants: number | null;
  duration_hours: string | null;
  duration_type: string | null;
  multi_day_count: number | null;
  difficulty: string | null;
  included: string[] | null;
  not_included: string[] | null;
  what_to_bring: string[] | null;
  /**
   * DATE-колонки. node-postgres отдаёт DATE ОБЪЕКТОМ `Date`, а не строкой —
   * тип обязан это признавать. Пока он врал «string», код звал `.trim()` и
   * ронял всю страницу тура (04.08).
   */
  season_start: string | Date | null;
  season_end: string | Date | null;
  seasonal_only: boolean | null;
  weather_dependent: boolean | null;
  rating: string | null;
  review_count: number | null;
  program?: unknown;
  safety_notes?: string[] | null;
  operator_name: string;
  operator_id: string;
  operator_contacts: unknown;
}

export interface TourCardReview {
  id: number;
  author_name: string;
  author_city: string | null;
  rating: number;
  comment: string;
  trip_date: string | null;
}

/** Колонки, добавленные миграцией 809 — их может не быть, если она отстала. */
const OPTIONAL_COLUMNS = 'ot.program, ot.safety_notes,';

function buildSql(withOptional: boolean): string {
  return `
    SELECT
      ot.id, ot.title, ot.description, ot.short_description,
      ot.base_price, ot.price_old, ot.price_unit,
      ot.activity_type, ot.location_type,
      ot.location_name, ot.latitude, ot.longitude,
      ot.meeting_point,
      ot.tour_image, ot.photos,
      ot.max_participants, ot.min_participants,
      ot.duration_hours, ot.duration_type, ot.multi_day_count,
      ot.difficulty,
      ot.included, ot.not_included, ot.what_to_bring,
      ot.season_start, ot.season_end, ot.seasonal_only,
      ot.weather_dependent,
      ot.rating, ot.review_count,
      ${withOptional ? OPTIONAL_COLUMNS : ''}
      p.name AS operator_name, p.id AS operator_id,
      p.contacts AS operator_contacts
    FROM operator_tours ot
    JOIN partners p ON ot.operator_id = p.id
    WHERE ot.id = $1
      AND ot.is_active = true
      AND ot.deleted_at IS NULL
  `;
}

/** Ошибка «нет такой колонки» — PostgreSQL код 42703. */
function isUndefinedColumn(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const code = (e as { code?: unknown }).code;
  return code === '42703';
}

export async function getTourForCard(id: number): Promise<TourCardRow | null> {
  try {
    const { rows } = await pool.query<TourCardRow>(buildSql(true), [id]);
    return rows[0] ?? null;
  } catch (e) {
    if (!isUndefinedColumn(e)) return null;
    // Миграция 809 ещё не применилась — отдаём карточку без её полей,
    // вместо того чтобы показать 404 на существующем туре.
    try {
      const { rows } = await pool.query<TourCardRow>(buildSql(false), [id]);
      return rows[0] ?? null;
    } catch {
      return null;
    }
  }
}

export async function getTourReviews(tourId: number): Promise<TourCardReview[]> {
  try {
    const { rows } = await pool.query<TourCardReview>(
      `SELECT id, author_name, author_city, rating, comment, trip_date
         FROM operator_tour_reviews
        WHERE tour_id = $1
        ORDER BY created_at DESC
        LIMIT 6`,
      [tourId],
    );
    return rows;
  } catch {
    return [];
  }
}
