/**
 * Notification Service
 *
 * Работает с настоящими колонками `notifications`: title, message, data,
 * is_read, priority, action_url. Раньше сервис писал и читал колонку `payload`,
 * которой нет ни в `lib/database/schema.sql`, ни в боевой базе — это показал
 * аудит 28.07 (`/api/cron/schema-audit`): таблица держит `title` и `message`
 * отдельными NOT NULL, а строк в ней 0 за всё время. То есть создание
 * уведомления падало на разборе запроса, `catch` возвращал выдуманный объект с
 * новым UUID, и вызывающий код видел успех. Ноль строк — цена такого «успеха».
 *
 * Поэтому здесь нет глушащих catch: если база отказала, вызывающий должен об
 * этом узнать. Молчаливый успех на платформе безопасности хуже явной ошибки.
 */

import {
  pool,
  toStringOrNull,
  toNumberOrNull,
  toBooleanOrNull,
} from '../_helpers';

/** Колонки, которые сервис читает. Одинаковы во всех выборках. */
const SELECT_COLUMNS =
  'id, user_id, type, title, message, data, is_read, priority, action_url, read_at, created_at, updated_at';

// In-memory store for notification preferences
const notificationPreferencesStore = new Map<string, Record<string, unknown>>();

export const notificationService = {
  normalize(row: Record<string, unknown> | null) {
    if (!row) return null;
    const dataCandidate = row.data;
    const data = dataCandidate && typeof dataCandidate === 'object'
      ? (dataCandidate as Record<string, unknown>)
      : {};

    const isRead = toBooleanOrNull(row.is_read) ?? row.read_at != null;

    return {
      id: row.id,
      userId: row.user_id ?? row.userId ?? null,
      user_id: row.user_id ?? row.userId ?? null,
      type: toStringOrNull(row.type),
      title: toStringOrNull(row.title),
      message: toStringOrNull(row.message),
      // Каналы и признак «заглушено» живут внутри data — отдельных колонок для
      // них в таблице нет, и выдумывать их миграцией ради двух полей незачем.
      channels: Array.isArray(data.channels) ? data.channels : [],
      data,
      muted: toBooleanOrNull(data.muted) ?? false,
      priority: toStringOrNull(row.priority),
      actionUrl: row.action_url ?? null,
      action_url: row.action_url ?? null,
      isRead,
      is_read: isRead,
      readAt: row.read_at ?? row.readAt ?? null,
      read_at: row.read_at ?? row.readAt ?? null,
      createdAt: row.created_at ?? row.createdAt ?? null,
      created_at: row.created_at ?? row.createdAt ?? null,
      updatedAt: row.updated_at ?? row.updatedAt ?? null,
      updated_at: row.updated_at ?? row.updatedAt ?? null,
    };
  },
  async send(userId: string, data: Record<string, unknown>) {
    return this.create({ userId, ...data });
  },
  async create(data: Record<string, unknown>) {
    const userId = toStringOrNull(data.userId) ?? toStringOrNull(data.user_id);
    if (!userId) {
      throw new Error('Не указан получатель уведомления');
    }

    // title и message — NOT NULL в таблице. Раньше их отсутствие превращалось в
    // ошибку базы, погашенную catch; теперь отказ понятен на входе.
    const title = toStringOrNull(data.title);
    const message = toStringOrNull(data.message);
    if (!title) throw new Error('Заголовок уведомления обязателен');
    if (!message) throw new Error('Текст уведомления обязателен');

    const extra: Record<string, unknown> = {};
    if (Array.isArray(data.channels)) extra.channels = data.channels;
    if (data.data && typeof data.data === 'object') {
      Object.assign(extra, data.data as Record<string, unknown>);
    }
    if (data.scheduledFor) extra.scheduledFor = data.scheduledFor;

    const result = await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, data, priority, action_url, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, NOW(), NOW())
       RETURNING ${SELECT_COLUMNS}`,
      [
        userId,
        toStringOrNull(data.type) ?? 'system',
        title,
        message,
        JSON.stringify(extra),
        toStringOrNull(data.priority) ?? 'normal',
        toStringOrNull(data.actionUrl) ?? toStringOrNull(data.action_url),
      ]
    );
    return this.normalize(result.rows[0] ?? null);
  },
  async list(arg1: unknown, arg2?: unknown, arg3?: unknown, arg4?: unknown) {
    const userId = toStringOrNull(arg1);
    const filters = (!userId && arg1 && typeof arg1 === 'object')
      ? (arg1 as Record<string, unknown>)
      : ((arg2 && typeof arg2 === 'object') ? (arg2 as Record<string, unknown>) : {});
    const limit = Math.min(Math.max(toNumberOrNull(userId ? arg3 : arg2) ?? 50, 1), 100);
    const offset = Math.max(toNumberOrNull(userId ? arg4 : arg3) ?? 0, 0);

    if (!userId) {
      return { notifications: [], total: 0 };
    }

    const unreadOnly = toBooleanOrNull(filters.unreadOnly) ?? false;
    const conditions: string[] = ['user_id = $1'];
    const values: unknown[] = [userId];

    if (unreadOnly) {
      conditions.push('is_read = FALSE');
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM notifications ${whereClause}`,
      values
    );
    const total = Number(countResult.rows[0]?.total ?? 0);

    const rowsResult = await pool.query(
      `SELECT ${SELECT_COLUMNS} FROM notifications
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${values.length + 1}
       OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );

    return {
      notifications: rowsResult.rows.map(row => this.normalize(row)),
      total,
    };
  },
  async getById(id: string) {
    const result = await pool.query(
      `SELECT ${SELECT_COLUMNS} FROM notifications WHERE id = $1 LIMIT 1`,
      [id]
    );
    return this.normalize(result.rows[0] ?? null);
  },
  async getByIdForUser(id: string, userId: string) {
    const result = await pool.query(
      `SELECT ${SELECT_COLUMNS} FROM notifications WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [id, userId]
    );
    return this.normalize(result.rows[0] ?? null);
  },
  async markRead(id: string, userId: string) {
    const result = await pool.query(
      `UPDATE notifications
       SET is_read = TRUE, read_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [id, userId]
    );
    return { success: result.rows.length > 0 };
  },
  async markAsRead(id: string, userId?: string) {
    if (!userId) {
      const result = await pool.query(
        `UPDATE notifications
         SET is_read = TRUE, read_at = NOW(), updated_at = NOW()
         WHERE id = $1
         RETURNING id`,
        [id]
      );
      return { success: result.rows.length > 0 };
    }

    return this.markRead(id, userId);
  },
  async toggleMute(id: string, muted: unknown) {
    const mutedValue = toBooleanOrNull(muted) ?? false;
    const result = await pool.query(
      `UPDATE notifications
       SET
         data = jsonb_set(COALESCE(data, '{}'::jsonb), '{muted}', to_jsonb($2::boolean), true),
         updated_at = NOW()
       WHERE id = $1
       RETURNING id`,
      [id, mutedValue]
    );
    return { success: result.rows.length > 0, id, muted: mutedValue };
  },
  async getPreferences(userId: string) {
    const existing = notificationPreferencesStore.get(userId);
    if (existing) {
      return existing;
    }
    return {
      quietHours: null,
      channelPreferences: {},
      typePreferences: {},
      frequencyLimit: null,
      unsubscribeAll: false,
    };
  },
  async updatePreferences(userId: string, preferences: Record<string, unknown>) {
    const current = await this.getPreferences(userId);
    const merged = {
      ...current,
      ...preferences,
      updatedAt: new Date().toISOString(),
    };
    notificationPreferencesStore.set(userId, merged);
    return merged;
  },
  async markAllRead(userId: string) {
    await pool.query(
      `UPDATE notifications
       SET is_read = TRUE, read_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND is_read = FALSE`,
      [userId]
    );
    return { success: true };
  },
  async deleteById(id: string) {
    const result = await pool.query(
      `DELETE FROM notifications WHERE id = $1 RETURNING id`,
      [id]
    );
    return result.rows.length > 0;
  },
  async deleteByIdForUser(id: string, userId: string) {
    const result = await pool.query(
      `DELETE FROM notifications WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, userId]
    );
    return result.rows.length > 0;
  },
};
