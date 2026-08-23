/**
 * Настройки уведомлений переживают перезапуск.
 *
 * Единственная находка «по делу» из сорока пяти в разборе 23.08: настройки
 * лежали в `new Map()` на уровне модуля. Пользователь их сохранял, PUT
 * отвечал успехом — а первый же выкат стирал всё, и GET после него отдавал
 * умолчания, неотличимые от «я так и настроил». На нескольких экземплярах
 * приложения тот же пользователь получал бы разные ответы от разных
 * процессов.
 *
 * Здесь проверяется поведение, а не наличие строчки: сервису подставлена
 * поддельная база, и спрашивается, что он в неё пишет и как читает.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

import { notificationService } from '@/lib/services/operators/notification.service';

beforeEach(() => {
  poolQueryMock.mockReset();
});

const USER = '11111111-1111-1111-1111-111111111111';

describe('настройки уведомлений хранятся в базе, а не в памяти процесса', () => {
  it('чтение идёт запросом к notification_preferences', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    await notificationService.getPreferences(USER);

    const sql = String(poolQueryMock.mock.calls[0][0]);
    expect(sql).toContain('notification_preferences');
    expect(poolQueryMock.mock.calls[0][1]).toEqual([USER]);
  });

  it('запись идёт UPSERT по user_id — параметризованным запросом', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [] })          // getPreferences внутри
      .mockResolvedValueOnce({ rows: [] });         // сам UPSERT

    await notificationService.updatePreferences(USER, { unsubscribeAll: true });

    const [sql, params] = poolQueryMock.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO notification_preferences');
    expect(sql).toContain('ON CONFLICT (user_id)');
    expect(params[0]).toBe(USER);
    expect(JSON.parse(String(params[1])).unsubscribeAll).toBe(true);
  });

  it('«никогда не настраивал» отличается от «настроил именно так»', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    const untouched = await notificationService.getPreferences(USER);
    expect(untouched.isDefault).toBe(true);
    expect(untouched.unsubscribeAll).toBe(false);

    poolQueryMock.mockResolvedValueOnce({
      rows: [{ prefs: { unsubscribeAll: false, frequencyLimit: 'daily' } }],
    });
    const chosen = await notificationService.getPreferences(USER);
    expect(chosen.isDefault).toBe(false);
    expect(chosen.frequencyLimit).toBe('daily');
  });

  it('правка одного поля не стирает остальные', async () => {
    // Эндпоинт передаёт все пять полей всегда; неуказанные приходят как
    // undefined. При обычном спреде они затирали бы сохранённое.
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ prefs: { frequencyLimit: 'daily', unsubscribeAll: true } }] })
      .mockResolvedValueOnce({ rows: [] });

    await notificationService.updatePreferences(USER, {
      quietHours: undefined,
      channelPreferences: undefined,
      typePreferences: undefined,
      frequencyLimit: undefined,
      unsubscribeAll: false,
    });

    const params = poolQueryMock.mock.calls[1][1] as unknown[];
    const saved = JSON.parse(String(params[1]));
    expect(saved.frequencyLimit).toBe('daily'); // не потеряно
    expect(saved.unsubscribeAll).toBe(false);   // изменено как просили
  });

  it('отказ базы не подменяется умолчаниями', async () => {
    poolQueryMock.mockRejectedValueOnce(new Error('57P01 admin shutdown'));
    await expect(notificationService.getPreferences(USER)).rejects.toThrow('57P01');
  });
});

describe('колонка prefs объявлена миграцией', () => {
  it('в migrations/ есть ALTER, добавляющий prefs', async () => {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync('migrations/910_notification_preferences_prefs.sql', 'utf8');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS prefs');
  });
});
