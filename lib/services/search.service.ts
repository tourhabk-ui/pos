/**
 * Search Service
 * Functions related to tour search, autocomplete, recommendations, and trending.
 */

import { pool, toStringOrNull, toNumberOrNull } from './_helpers';
import { tourService } from './tours/tour.service';

export const searchService = {
  async search(queryOrParams: unknown, maybeParams?: Record<string, unknown>) {
    const params = typeof queryOrParams === 'string'
      ? { ...(maybeParams ?? {}), query: queryOrParams }
      : ((queryOrParams && typeof queryOrParams === 'object')
        ? (queryOrParams as Record<string, unknown>)
        : {});

    const result = await tourService.search(params);
    return {
      tours: result.tours,
      total: result.total,
      hasMore: result.hasMore,
      query: toStringOrNull(params.query) ?? '',
    };
  },
  async advancedSearch(params: Record<string, unknown>) {
    const startedAt = Date.now();
    const result = await this.search(params);
    const filters = params.filters && typeof params.filters === 'object'
      ? (params.filters as Record<string, unknown>)
      : {};

    return {
      tours: result.tours,
      total: result.total,
      hasMore: result.hasMore,
      facets: {
        activities: filters.activity ? [filters.activity] : [],
        difficulties: filters.difficulty ? [filters.difficulty] : [],
      },
      executionTime: Date.now() - startedAt,
    };
  },
  async autocomplete(query: string, limit = 10) {
    if (!query.trim()) return [];
    const result = await pool.query(
      `SELECT DISTINCT title AS name
       FROM operator_tours
       WHERE is_active = TRUE AND deleted_at IS NULL AND title ILIKE $1
       ORDER BY name ASC
       LIMIT $2`,
      [`%${query.trim()}%`, Math.min(Math.max(limit, 1), 50)]
    );
    return result.rows
      .map(row => toStringOrNull(row.name))
      .filter((value): value is string => Boolean(value));
  },
  async getRecommended(limit = 10, operatorId?: string) {
    const params: unknown[] = [];
    const conditions: string[] = ['is_active = TRUE'];

    if (operatorId) {
      conditions.push(`operator_id = $${params.length + 1}`);
      params.push(operatorId);
    }

    params.push(Math.min(Math.max(limit, 1), 50));
    const result = await pool.query(
      `SELECT id, title, title AS name, description, activity_type AS category, activity_type,
              difficulty, duration_hours AS duration, base_price AS price, base_price,
              operator_id, max_participants AS max_group_size, min_participants AS min_group_size,
              rating, review_count, is_active, tour_image, created_at, updated_at
       FROM operator_tours
       WHERE ${conditions.join(' AND ')} AND deleted_at IS NULL
       ORDER BY COALESCE(rating, 0) DESC, created_at DESC
       LIMIT $${params.length}`,
      params
    );
    return result.rows.map(row => tourService.normalize(row));
  },
  async getTrending(limit = 10) {
    const result = await pool.query(
      `SELECT id, title, title AS name, description, activity_type AS category, activity_type,
              difficulty, duration_hours AS duration, base_price AS price, base_price,
              operator_id, max_participants AS max_group_size, min_participants AS min_group_size,
              rating, review_count, is_active, tour_image, created_at, updated_at
       FROM operator_tours
       WHERE is_active = TRUE AND deleted_at IS NULL
       ORDER BY COALESCE(review_count, 0) DESC, COALESCE(rating, 0) DESC
       LIMIT $1`,
      [Math.min(Math.max(limit, 1), 50)]
    );
    return result.rows.map(row => tourService.normalize(row));
  },
  async getPopularTags(limit = 20) {
    const result = await pool.query(
      `SELECT activity_type AS category, COUNT(*)::int AS cnt
       FROM operator_tours
       WHERE is_active = TRUE AND deleted_at IS NULL AND activity_type IS NOT NULL
       GROUP BY activity_type
       ORDER BY cnt DESC
       LIMIT $1`,
      [Math.min(Math.max(limit, 1), 100)]
    );
    return result.rows.map(row => ({
      tag: toStringOrNull(row.category) ?? 'other',
      count: Number(row.cnt ?? 0),
    }));
  },
  async getSimilar(tourId: string, limit = 5) {
    const sourceTour = await pool.query(
      `SELECT id, activity_type AS category, difficulty FROM operator_tours WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [tourId]
    );
    const base = sourceTour.rows[0];
    if (!base) {
      return [];
    }

    const result = await pool.query(
      `SELECT id, title, title AS name, description, activity_type AS category, activity_type,
              difficulty, duration_hours AS duration, base_price AS price, base_price,
              operator_id, max_participants AS max_group_size, min_participants AS min_group_size,
              rating, review_count, is_active, tour_image, created_at, updated_at
       FROM operator_tours
       WHERE
         is_active = TRUE
         AND deleted_at IS NULL
         AND id <> $1
         AND (
           (activity_type IS NOT DISTINCT FROM $2)
           OR (difficulty IS NOT DISTINCT FROM $3)
         )
       ORDER BY COALESCE(rating, 0) DESC, created_at DESC
       LIMIT $4`,
      [tourId, base.category ?? null, base.difficulty ?? null, Math.min(Math.max(limit, 1), 20)]
    );
    return result.rows.map(row => tourService.normalize(row));
  },
};
