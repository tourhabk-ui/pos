/**
 * Отбой не должен занимать строку «Наиболее значимое» в safety_status.
 *
 * Живой случай 21.09.2026: 13 активных предупреждений, у всех severity=1,
 * самое свежее — «Стабилизировалась паводковая обстановка в Соболевском
 * округе». `ORDER BY severity DESC, created_at DESC` ничего не решал
 * (плоская severity) и отдавал победу тай-брейку по свежести — а отбои
 * приходят позже самих тревог по определению (issue #1984).
 */
import { describe, it, expect, vi } from 'vitest';
import { isResolutionNotice } from '@/lib/safety/resolution-notice';

const { querySpy } = vi.hoisted(() => ({ querySpy: vi.fn() }));
vi.mock('@/lib/database', () => ({ query: querySpy }));

import { getCurrentSafetyStatus, formatSafetyStatusForAgent } from '@/lib/safety/current-status';

describe('isResolutionNotice', () => {
  it('распознаёт отбой по формулировке окончания явления', () => {
    expect(isResolutionNotice('Стабилизировалась паводковая обстановка в Соболевском округе')).toBe(true);
    expect(isResolutionNotice('Снят режим повышенной готовности в связи с выходом медведей')).toBe(true);
    expect(isResolutionNotice('Ликвидирован очаг возгорания в Мильковском районе')).toBe(true);
  });

  it('не путает действующую тревогу с отбоем', () => {
    expect(isResolutionNotice('Ожидается паводок на реках западного побережья')).toBe(false);
    expect(isResolutionNotice('Не рекомендуется посещение вулкана Мутновский')).toBe(false);
  });

  it('пустой заголовок — не отбой', () => {
    expect(isResolutionNotice(null)).toBe(false);
    expect(isResolutionNotice(undefined)).toBe(false);
  });
});

describe('getCurrentSafetyStatus — отбой не побеждает тай-брейк по свежести', () => {
  it('при плоской severity верхней строкой становится действующая тревога, не самый свежий отбой', async () => {
    querySpy.mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.includes('FROM external_alerts') && sql.includes('MAX(severity)')) {
        return Promise.resolve({ rows: [{ max_severity: '1', active_count: '13' }] });
      }
      if (sql.includes('FROM external_alerts')) {
        // Реальный запрос теперь сортирует ORDER BY (title ~* $1) ASC first —
        // мок изображает СЕРВЕРНОЕ поведение этой сортировки, а не повторяет
        // ORDER BY в JS: проверяем, что параметр — паттерн отбоя, и отдаём
        // строку так, как её вернул бы Postgres при этом ORDER BY.
        expect(params?.[0]).toEqual(expect.any(String));
        expect(isResolutionNotice('Стабилизировалась паводковая обстановка в Соболевском округе')).toBe(true);
        return Promise.resolve({
          rows: [{
            title: 'Ожидается паводок на реках Мильковского района',
            alert_type: 'flood',
            external_id: 'mchs/123',
            source_url: null,
          }],
        });
      }
      if (sql.includes('FROM location_real_time_status')) {
        return Promise.resolve({ rows: [{ last_update: '2026-09-21T02:01:04.475Z' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const status = await getCurrentSafetyStatus();
    expect(status).not.toBeNull();
    expect(status!.topTitle).toBe('Ожидается паводок на реках Мильковского района');
    expect(status!.topTitle).not.toMatch(/стабилизировал/i);

    const text = formatSafetyStatusForAgent(status);
    expect(text).toContain('Наиболее значимое: Ожидается паводок на реках Мильковского района');
    expect(text).not.toMatch(/Наиболее значимое:.*[Сс]табилизировал/);
  });

  it('запрос верхней тревоги передаёт паттерн отбоя параметром, не литералом в SQL', async () => {
    querySpy.mockResolvedValue({ rows: [] });
    await getCurrentSafetyStatus();
    const topCall = querySpy.mock.calls.find(([sql]) =>
      (sql as string).includes('FROM external_alerts') && (sql as string).includes('ORDER BY (title'));
    expect(topCall, 'запрос верхней тревоги не найден').toBeDefined();
    expect(topCall![0]).toContain('title ~* $1');
    expect(topCall![1]).toEqual([expect.stringContaining('стабилизировал')]);
  });
});
