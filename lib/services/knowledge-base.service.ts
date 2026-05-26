/**
 * Knowledge Base Service
 * Functions related to knowledge base articles search, CRUD.
 */

import { pool, toStringOrNull, toNumberOrNull } from './_helpers';

const ALLOWED_UPDATE_FIELDS = new Set(['title', 'content', 'category', 'tags']);

export const knowledgeBaseService = {
  async search(searchQuery: string) {
    try {
      const like = `%${searchQuery}%`;
      const res = await pool.query(
        `SELECT id, title, slug, category, tags, author, views, helpful, created_at
         FROM knowledge_base_articles
         WHERE title ILIKE $1 OR content ILIKE $1
         ORDER BY helpful DESC, views DESC
         LIMIT 20`,
        [like]
      );
      return { articles: res.rows, total: res.rows.length };
    } catch {
      return { articles: [], total: 0 };
    }
  },
  async list(params: Record<string, unknown>) {
    try {
      const page = toNumberOrNull(params.page) ?? 1;
      const limit = Math.min(toNumberOrNull(params.limit) ?? 20, 100);
      const offset = (page - 1) * limit;
      const category = toStringOrNull(params.category);

      const [countRes, dataRes] = await Promise.all([
        category
          ? pool.query(`SELECT COUNT(*)::int AS total FROM knowledge_base_articles WHERE category = $1`, [category])
          : pool.query(`SELECT COUNT(*)::int AS total FROM knowledge_base_articles`),
        category
          ? pool.query(
              `SELECT id, title, slug, category, tags, author, views, helpful, created_at
               FROM knowledge_base_articles WHERE category = $1
               ORDER BY helpful DESC, created_at DESC LIMIT $2 OFFSET $3`,
              [category, limit, offset]
            )
          : pool.query(
              `SELECT id, title, slug, category, tags, author, views, helpful, created_at
               FROM knowledge_base_articles
               ORDER BY helpful DESC, created_at DESC LIMIT $1 OFFSET $2`,
              [limit, offset]
            ),
      ]);
      return {
        articles: dataRes.rows,
        total: Number(countRes.rows[0]?.total ?? 0),
      };
    } catch {
      return { articles: [], total: 0 };
    }
  },
  async getById(id: string) {
    try {
      const res = await pool.query(
        `SELECT id, title, slug, content, category, tags, author, views, helpful, created_at, updated_at
         FROM knowledge_base_articles WHERE id = $1`,
        [id]
      );
      return res.rows[0] ?? null;
    } catch {
      return null;
    }
  },
  async create(data: Record<string, unknown>) {
    try {
      const title = toStringOrNull(data.title) ?? '';
      const slug = toStringOrNull(data.slug) ?? title.toLowerCase().replace(/\s+/g, '-');
      const content = toStringOrNull(data.content) ?? '';
      const category = toStringOrNull(data.category) ?? 'general';
      const author = toStringOrNull(data.author) ?? 'system';
      const tags = Array.isArray(data.tags) ? data.tags : [];

      const res = await pool.query(
        `INSERT INTO knowledge_base_articles (title, slug, content, category, author, tags, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING id, title, slug, category, author, tags, created_at`,
        [title, slug, content, category, author, tags]
      );
      return res.rows[0];
    } catch {
      return { id: 0, ...data };
    }
  },
  async update(id: string, data: Record<string, unknown>) {
    try {
      const allowed = Array.from(ALLOWED_UPDATE_FIELDS).filter(k => k in data);
      if (allowed.length === 0) return { id, ...data };
      const fields = allowed.map((k, i) => `${k} = $${i + 2}`);
      const values = allowed.map(k => data[k]);
      const res = await pool.query(
        `UPDATE knowledge_base_articles SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [id, ...values]
      );
      return res.rows[0] ?? { id, ...data };
    } catch {
      return { id, ...data };
    }
  },
  async searchArticles(filter: Record<string, unknown>) {
    const searchTerm = toStringOrNull(filter.search) ?? '';
    const result = searchTerm ? await this.search(searchTerm) : await this.list(filter);
    return {
      success: true,
      data: result.articles,
      total: result.total,
      page: toNumberOrNull(filter.page) ?? 1,
      limit: toNumberOrNull(filter.limit) ?? 20,
    };
  },
  async createArticle(data: Record<string, unknown>, author: string) {
    return this.create({ ...data, author });
  },
};
