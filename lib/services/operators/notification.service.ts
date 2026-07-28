/**
 * Notification Service
 * Functions related to notification CRUD, preferences, and muting.
 *
 * Сервис был построен вокруг колонки `payload`, которой нет ни в одном файле
 * схемы: таблица `notifications` держит `title` и `message` отдельными NOT NULL,
 * а рядом `data JSONB` для остального. То есть ни один запрос отсюда выполниться
 * не мог — и это молчало худшим из возможных способов: `create` ловил ошибку и
 * ВОЗВРАЩАЛ ВЫДУМАННОЕ уведомление с новым UUID, будто оно сохранено.
 * Вызывающая сторона видела успех, пользователь не получал ничего.
 *
 * Из двух моделей выбрана табличная: отдельные колонки дают NOT NULL, индексы и
 * внятные запросы. JSON-мешок не даёт ничего из этого и молча теряет форму —
 * заголовок уведомления может просто исчезнуть, и никто не узнает.
 *
 * Чтение остаётся терпимым к старой форме: если строка пришла с `payload`
 * (например из `RETURNING *` на базе, где колонку когда-то добавили руками),
 * значения возьмутся оттуда. Запись идёт только в объявленные колонки.
 */

import {
  pool,
  toStringOrNull,
  toNumberOrNull,
  toBooleanOrNull,
} from '../_helpers';

/** Колонки, которые реально объявлены схемой. `payload` среди них нет. */
const COLUMNS = 'id, user_id, type, title, message, data, priority, action_url, is_read, read_at, created_at, updated_at';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// In-memory store for notification preferences
const notificationPreferencesStore = new Map<string, Record<string, unknown>>();

export const notificationService = {
  normalize(row: Record<string, unknown> | null) {
    if (!row) return null;
    // `legacy` — на случай строки со старой формой; из БД мы её не запрашиваем.
    const legacy = asRecord(row.payload);
    const extra = asRecord(row.data);

    const title = toStringOrNull(row.title) ?? toStringOrNull(legacy.title);
    const message = toStringOrNull(row.message) ?? toStringOrNull(legacy.message);
    const channels = Array.isArray(extra.channels)
      ? extra.channels
      : (Array.isArray(legacy.channels) ? legacy.channels : []);
    const payloadData = extra.data ?? legacy.data ?? {};
    const muted = toBooleanOrNull(extra.muted) ?? toBooleanOrNull(legacy.muted) ?? false;

    return {
      id: row.id,
      userId: row.user_id ?? row.userId ?? null,
      user_id: row.user_id ?? row.userId ?? null,
      type: toStringOrNull(row.type),
      title,
      message,
      channels,
      data: payloadData,
      muted,
      readAt: row.read_at ?? row.readAt ?? null,
      read_at: row.read_at ?? row.readAt ?? null,
      createdAt: row.created_at ?? row.createdAt ?? null,
      updatedAt: row.updated_at ?? row.updatedAt ?? null,
      // Форма ответа для клиентов сохранена: раньше здесь лежал JSON из БД,
      // теперь он собирается из колонок. Снаружи разницы нет.
      payload: { title, message, channels, data: payloadData, muted },
    };
  },
  async send(userId: string, data: Record<string, unknown>) {
    return this.create({ userId, ...data });
  },
  async create(data: Record<string, unknown>) {
    const userId = toStringOrNull(data.userId) ?? toStringOrNull(data.user_id);
    if (!userId) {
      throw new Error('userId is required');
    }

    const title = toStringOrNull(data.title);
    const message = toStringOrNull(data.message);
    // title и message в таблице NOT NULL — и это правильно: уведомление без
    // текста бесполезно. Говорим об этом сразу и по-русски, а не отдаём ошибку
    // базы.
    if (!title || !message) {
      throw new Error('Уведомление без заголовка или текста не создаётся');
    }

    // Всё, что не легло в отдельные колонки, идёт в data — там ему и место.
    const extra: Record<string, unknown> = {};
    if (Array.isArray(data.channels)) extra.channels = data.channels;
    if (data.data && typeof data.data === 'object') extra.data = data.data;
    if (data.scheduledFor) extra.scheduledFor = data.scheduledFor;

    // Ошибку НЕ глотаем. Раньше здесь стоял catch, возвращавший выдуманное
    // уведомление с новым UUID: вызывающая сторона видела успех, пользователь
    // не получал ничего. Пусть лучше маршрут отдаст честную пятисотку.
    const result = await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), NOW())
       RETURNING ${COLUMNS}`,
      [userId, toStringOrNull(data.type) ?? 'system', title, message, JSON.stringify(extra)]
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
      conditions.push('read_at IS NULL');
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM notifications ${whereClause}`,
      values
    );
    const total = Number(countResult.rows[0]?.total ?? 0);

    const rowsResult = await pool.query(
      `SELECT ${COLUMNS} FROM notifications
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
    try {
      const result = await pool.query(
        `SELECT ${COLUMNS} FROM notifications WHERE id = $1 LIMIT 1`,
        [id]
      );
      return this.normalize(result.rows[0] ?? null);
    } catch {
      return null;
    }
  },
  async getByIdForUser(id: string, userId: string) {
    try {
      const result = await pool.query(
        `SELECT ${COLUMNS} FROM notifications WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [id, userId]
      );
      return this.normalize(result.rows[0] ?? null);
    } catch {
      return null;
    }
  },
  // Ошибки отметки о прочтении и отключения звука тоже не глотаем: раньше все
  // три возвращали success: true при неудачном запросе. Пользователь видел, что
  // уведомление прочитано, база об этом не знала, и на следующем экране оно
  // возвращалось непрочитанным.
  async markRead(id: string, userId: string) {
    await pool.query(
      `UPDATE notifications
       SET read_at = NOW(), is_read = TRUE, updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    return { success: true };
  },
  async markAsRead(id: string, userId?: string) {
    if (!userId) {
      await pool.query(
        `UPDATE notifications
         SET read_at = NOW(), is_read = TRUE, updated_at = NOW()
         WHERE id = $1`,
        [id]
      );
      return { success: true };
    }

    return this.markRead(id, userId);
  },
  async toggleMute(id: string, muted: unknown) {
    const mutedValue = toBooleanOrNull(muted) ?? false;
    await pool.query(
      `UPDATE notifications
       SET
         data = jsonb_set(COALESCE(data, '{}'::jsonb), '{muted}', to_jsonb($2::boolean), true),
         updated_at = NOW()
       WHERE id = $1`,
      [id, mutedValue]
    );
    return { success: true, id, muted: mutedValue };
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
       SET read_at = NOW(), is_read = TRUE, updated_at = NOW()
       WHERE user_id = $1`,
      [userId]
    );
    return { success: true };
  },
  async deleteById(id: string) {
    try {
      const result = await pool.query(
        `DELETE FROM notifications WHERE id = $1 RETURNING id`,
        [id]
      );
      return result.rows.length > 0;
    } catch {
      return false;
    }
  },
  async deleteByIdForUser(id: string, userId: string) {
    try {
      const result = await pool.query(
        `DELETE FROM notifications WHERE id = $1 AND user_id = $2 RETURNING id`,
        [id, userId]
      );
      return result.rows.length > 0;
    } catch {
      return false;
    }
  },
};
