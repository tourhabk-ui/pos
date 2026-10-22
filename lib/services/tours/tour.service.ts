/**
 * Tour Service
 * Functions related to tour CRUD, search, publishing, and statistics.
 */

import {
  pool,
  toStringOrNull,
  toNumberOrNull,
  toBooleanOrNull,
  TourNotFoundError,
  TourValidationError,
  TourAlreadyPublishedError,
} from '../_helpers';
import { publicTourSql } from '@/lib/tours/public-visibility';

export const tourService = {
  normalize(row: Record<string, unknown> | null) {
    if (!row) {
      return null;
    }

    const isActive = toBooleanOrNull(row.is_active ?? row.isActive) ?? false;
    return {
      id: row.id,
      name: toStringOrNull(row.name) ?? toStringOrNull(row.title) ?? '',
      title: toStringOrNull(row.name) ?? toStringOrNull(row.title) ?? '',
      description: toStringOrNull(row.description) ?? '',
      category: toStringOrNull(row.category) ?? null,
      difficulty: toStringOrNull(row.difficulty) ?? null,
      duration: toNumberOrNull(row.duration),
      price: toNumberOrNull(row.price ?? row.price_from),
      currency: toStringOrNull(row.currency) ?? 'RUB',
      operatorId: row.operator_id ?? row.operatorId ?? null,
      maxGroupSize: toNumberOrNull(row.max_group_size ?? row.maxGroupSize),
      minGroupSize: toNumberOrNull(row.min_group_size ?? row.minGroupSize),
      rating: toNumberOrNull(row.rating) ?? 0,
      reviewCount: toNumberOrNull(row.review_count ?? row.reviews_count) ?? 0,
      isActive,
      status: isActive ? 'published' : 'draft',
      createdAt: row.created_at ?? row.createdAt ?? null,
      updatedAt: row.updated_at ?? row.updatedAt ?? null,
      operatorName: toStringOrNull(row.operator_name),
    };
  },
  async search(params: Record<string, unknown>) {
    try {
      const limit = Math.min(toNumberOrNull(params.limit) ?? 20, 100);
      const offset = toNumberOrNull(params.offset) ?? 0;
      const query = toStringOrNull(params.query)?.trim();
      const sortBy = toStringOrNull(params.sortBy) ?? 'rating';
      const sortOrder = (toStringOrNull(params.sortOrder) ?? 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
      const filters = params.filters && typeof params.filters === 'object'
        ? (params.filters as Record<string, unknown>)
        : {};

      // Отбор для туриста (GET /api/discovery/search) — шлюзом витрины (#2642):
      // без is_published черновик оператора находился поиском.
      const conditions: string[] = [publicTourSql('t')];
      const queryParams: unknown[] = [];

      if (query) {
        conditions.push(`(t.title ILIKE $${queryParams.length + 1} OR t.description ILIKE $${queryParams.length + 1})`);
        queryParams.push(`%${query}%`);
      }

      const difficulty = toStringOrNull(filters.difficulty);
      if (difficulty) {
        conditions.push(`t.difficulty = $${queryParams.length + 1}`);
        queryParams.push(difficulty);
      }

      const activity = toStringOrNull(filters.activity);
      if (activity) {
        conditions.push(`t.activity_type = $${queryParams.length + 1}`);
        queryParams.push(activity);
      }

      const minPrice = toNumberOrNull(filters.minPrice);
      if (minPrice !== null) {
        conditions.push(`t.base_price >= $${queryParams.length + 1}`);
        queryParams.push(minPrice);
      }

      const maxPrice = toNumberOrNull(filters.maxPrice);
      if (maxPrice !== null) {
        conditions.push(`t.base_price <= $${queryParams.length + 1}`);
        queryParams.push(maxPrice);
      }

      const minRating = toNumberOrNull(filters.rating);
      if (minRating !== null) {
        conditions.push(`COALESCE(t.rating, 0) >= $${queryParams.length + 1}`);
        queryParams.push(minRating);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const allowedSortFields: Record<string, string> = {
        rating: 't.rating',
        price: 't.base_price',
        created_at: 't.created_at',
        duration: 't.duration_hours',
        name: 't.title',
      };
      const orderField = allowedSortFields[sortBy] ?? 't.rating';

      const count = await pool.query(
        `SELECT COUNT(*)::int AS total FROM operator_tours t ${whereClause}`,
        queryParams
      );
      const total = Number(count.rows[0]?.total ?? 0);

      const result = await pool.query(
        `SELECT
           t.*,
           p.name AS operator_name
         FROM operator_tours t
         LEFT JOIN partners p ON t.operator_id = p.id
         ${whereClause}
         ORDER BY ${orderField} ${sortOrder}
         LIMIT $${queryParams.length + 1}
         OFFSET $${queryParams.length + 2}`,
        [...queryParams, limit, offset]
      );

      return {
        tours: result.rows.map(row => this.normalize(row)),
        total,
        hasMore: offset + limit < total,
      };
    } catch (e) {
      // Отказ базы — не «туров нет» (§4.0): глушение отдавало пустую выдачу с
      // success: true. Роут поиска ловит и отвечает 500.
      console.error('[tourService.search] отбор туров не выполнен:', e instanceof Error ? e.message : String(e));
      throw e;
    }
  },
  async getById(id: string) {
    const result = await pool.query(
      `SELECT
         t.*,
         p.name AS operator_name
       FROM operator_tours t
       LEFT JOIN partners p ON t.operator_id = p.id
       WHERE t.id = $1 AND t.deleted_at IS NULL
       LIMIT 1`,
      [id]
    );
    if (!result.rows[0]) throw new TourNotFoundError(id);
    return this.normalize(result.rows[0] ?? null);
  },
  async read(id: string) {
    return this.getById(id);
  },
  async create(data: Record<string, unknown>) {
    const name = toStringOrNull(data.name) ?? toStringOrNull(data.title);
    const description = toStringOrNull(data.description);
    const operatorId = toStringOrNull(data.operatorId) ?? toStringOrNull(data.operator_id);
    const difficulty = toStringOrNull(data.difficulty) ?? 'medium';
    const duration = toNumberOrNull(data.duration) ?? 1;
    const price = toNumberOrNull(data.price) ?? toNumberOrNull(data.priceFrom) ?? toNumberOrNull(data.price_from);
    const category = toStringOrNull(data.category) ?? toStringOrNull(data.activity) ?? 'adventure';
    const currency = toStringOrNull(data.currency) ?? 'RUB';
    const maxGroupSize = toNumberOrNull(data.maxGroupSize) ?? toNumberOrNull(data.max_group_size) ?? 20;
    const minGroupSize = toNumberOrNull(data.minGroupSize) ?? toNumberOrNull(data.min_group_size) ?? 1;

    if (!name || !description || !operatorId || price === null) {
      throw new TourValidationError('Required fields: name, description, operatorId, price');
    }

    if (duration < 1 || duration > 30) {
      throw new TourValidationError('Duration must be between 1 and 30');
    }

    const validDifficulties = new Set(['easy', 'medium', 'hard', 'extreme']);
    if (!validDifficulties.has(difficulty)) {
      throw new TourValidationError('Invalid difficulty value');
    }

    const result = await pool.query(
      // Пишем в мастер-таблицу: `tours` — совместимая VIEW (миграция 132), и
      // половины этих колонок в ней нет (currency, max_group_size), а значит
      // запрос падал на разборе.
      `INSERT INTO operator_tours (
         title,
         description,
         activity_type,
         difficulty,
         duration_hours,
         base_price,
         currency,
         operator_id,
         max_participants,
         min_participants,
         is_active,
         created_at,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, FALSE, NOW(), NOW())
       RETURNING *`,
      [name, description, category, difficulty, duration, price, currency, operatorId, maxGroupSize, minGroupSize]
    );
    return this.normalize(result.rows[0] ?? null);
  },
  // `update()` снят (аудит 15.10, P2-02): сирота без единого вызывающего
  // (#1827), писал `UPDATE tours` — в запрещённую таблицу (CLAUDE.md §4) и
  // колонками, которых у мастер-таблицы нет (`name`, `category`, `duration`,
  // `price`). Правка тура живёт в кабинете оператора — `PATCH
  // /api/hub/operator/tours/[id]`, запись в `operator_tours`.
  async publish(id: string) {
    const tour = await this.getById(id);
    if (tour?.isActive) throw new TourAlreadyPublishedError(id);
    const result = await pool.query(
      // `tours` — не VIEW, отдельная несовместимая таблица (#1814/#1827):
      // запрос отвергался на разборе и не выполнялся никогда.
      `UPDATE operator_tours SET is_active = TRUE, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );
    return this.normalize(result.rows[0] ?? null);
  },
  async unpublish(id: string) {
    const tour = await this.getById(id);
    if (!tour) throw new TourNotFoundError(id);
    const result = await pool.query(
      `UPDATE operator_tours SET is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );
    return this.normalize(result.rows[0] ?? null);
  },
  // `getStats()` снят (аудит 15.10, P2-02, п. 1.12) вместе с единственным
  // вызывающим — `GET /api/discovery/tours/[id]/stats`, у которого не было
  // ни одного вызова из интерфейса. Запрос отзывов в нём не выполнялся
  // никогда (`reviews.tour_id` uuid против bigint id тура), и роут отвечал
  // 500 на любой тур.
  async delete(id: string) {
    const result = await pool.query(`DELETE FROM operator_tours WHERE id = $1 RETURNING id`, [id]);
    if (!result.rows[0]) {
      throw new TourNotFoundError(id);
    }
    return { success: true, id: result.rows[0].id };
  },
};
