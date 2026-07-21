/**
 * Partner Service
 * Functions related to partner CRUD, listing, and activation.
 */

import {
  pool,
  toStringOrNull,
  toNumberOrNull,
  toBooleanOrNull,
} from '../_helpers';

export const partnerService = {
  normalize(row: Record<string, unknown> | null) {
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id ?? null,
      type: toStringOrNull(row.category),
      companyName: toStringOrNull(row.name),
      verified: toBooleanOrNull(row.is_verified) ?? false,
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null,
    };
  },
  async getById(id: string) {
    const result = await pool.query(
      `SELECT id, user_id, name, category, description, contact, rating, review_count,
              is_verified, logo_asset_id, slug, short_description, hero_image, logo_image,
              location, is_public, created_at, updated_at
       FROM partners WHERE id = $1`,
      [id]
    );
    return this.normalize(result.rows[0] ?? null);
  },
  async getPartner(id: string) {
    const partner = await this.getById(id);
    if (!partner) {
      throw new Error('Partner not found');
    }
    return partner;
  },
  async list(params: Record<string, unknown>) {
    const page = Math.max(toNumberOrNull(params.page) ?? 1, 1);
    const limit = Math.min(Math.max(toNumberOrNull(params.limit) ?? 20, 1), 100);
    const offset = (page - 1) * limit;
    const status = toStringOrNull(params.status);
    const type = toStringOrNull(params.type);

    const conditions: string[] = [];
    const values: unknown[] = [];

    if (type) {
      conditions.push(`type = $${values.length + 1}`);
      values.push(type);
    }

    if (status === 'verified' || status === 'active') {
      conditions.push(`verified = TRUE`);
    } else if (status === 'pending') {
      conditions.push(`verified = FALSE`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM partners ${whereClause}`,
      values
    );
    const total = Number(countResult.rows[0]?.total ?? 0);

    const result = await pool.query(
      `SELECT id, user_id, name, category, description, contact, rating, review_count,
              is_verified, logo_asset_id, slug, short_description, hero_image, logo_image,
              location, is_public, created_at, updated_at
       FROM partners ${whereClause} ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );
    return {
      partners: result.rows.map(row => this.normalize(row)),
      total,
      hasMore: offset + limit < total,
      page,
      limit,
    };
  },
  async listPartners(params: Record<string, unknown>) {
    const result = await this.list(params);
    return {
      success: true,
      data: result.partners,
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        hasMore: result.hasMore,
      },
    };
  },
  async create(data: Record<string, unknown>) {
    const userId = toStringOrNull(data.userId) ?? toStringOrNull(data.user_id);
    const category = toStringOrNull(data.type) ?? toStringOrNull(data.category) ?? 'operator';
    const name = toStringOrNull(data.companyName) ?? toStringOrNull(data.company_name) ?? toStringOrNull(data.name) ?? 'Partner';
    const isVerified = toBooleanOrNull(data.verified) ?? toBooleanOrNull(data.is_verified) ?? false;

    if (!userId) {
      throw new Error('userId is required');
    }

    const result = await pool.query(
      `INSERT INTO partners (user_id, category, name, is_verified, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       RETURNING id, user_id, name, category, is_verified, created_at, updated_at`,
      [userId, category, name, isVerified]
    );

    return this.normalize(result.rows[0] ?? null);
  },
  async createPartner(data: Record<string, unknown>) {
    return this.create(data);
  },
  async update(id: string, data: Record<string, unknown>) {
    const updates: string[] = [];
    const values: unknown[] = [];

    const name = toStringOrNull(data.companyName) ?? toStringOrNull(data.company_name) ?? toStringOrNull(data.name);
    if (name) {
      updates.push(`name = $${values.length + 1}`);
      values.push(name);
    }

    const category = toStringOrNull(data.type) ?? toStringOrNull(data.category);
    if (category) {
      updates.push(`category = $${values.length + 1}`);
      values.push(category);
    }

    const isVerified = toBooleanOrNull(data.verified) ?? toBooleanOrNull(data.is_verified);
    if (isVerified !== null) {
      updates.push(`is_verified = $${values.length + 1}`);
      values.push(isVerified);
    }

    if (updates.length === 0) {
      return this.getPartner(id);
    }

    values.push(id);
    const result = await pool.query(
      `UPDATE partners
       SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${values.length}
       RETURNING id, user_id, name, category, is_verified, created_at, updated_at`,
      values
    );

    if (!result.rows[0]) {
      throw new Error('Partner not found');
    }
    return this.normalize(result.rows[0] ?? null);
  },
  async updatePartner(id: string, data: Record<string, unknown>) {
    return this.update(id, data);
  },
  async activatePartner(id: string) {
    return this.update(id, { verified: true });
  },
};
