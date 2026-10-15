/**
 * Editor не заполняет снятое описание текстом модели (15.10, §0 «честность»).
 *
 * Дневники мест (1247) и описания маршрутов, написанные по одному названию
 * (1261), сняты с карточек в архивную колонку и ждут переписи по источникам.
 * Отбор Editor брал `description IS NULL` первым приоритетом и архива не
 * спрашивал — каждую ночь (22:00 UTC) он заполнял бы снятое новым текстом.
 *
 * Выполнение проверено на PostgreSQL сценой: из двух мест без описания отбор
 * взял пустое и пропустил снятый дневник. Здесь держится связка: отбор и счёт
 * очереди спрашивают архив обеих таблиц.
 */
import { describe, it, expect, vi } from 'vitest';

const poolQueryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => poolQueryMock(sql, params) },
}));

import { findRoutesNeedingDescription, notWithdrawnSql } from '@/lib/agents/editor';

describe('отбор Editor', () => {
  it('исключает снятые описания мест и маршрутов', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    await findRoutesNeedingDescription();
    const sql = String(poolQueryMock.mock.calls[0]?.[0] ?? '');
    expect(sql).toMatch(/FROM places w\s+WHERE w\.ark_id = ark\.id AND w\.description_withdrawn IS NOT NULL/);
    expect(sql).toMatch(/FROM kamchatka_routes wr\s+WHERE COALESCE\(wr\.ark_id, wr\.id\) = ark\.id AND wr\.description_withdrawn IS NOT NULL/);
    // Условие стоит поверх обеих веток отбора — и пустых, и коротких.
    expect(sql).toMatch(/WHERE \(ark\.description IS NULL[\s\S]*\)\)\s+AND NOT EXISTS/);
  });

  it('предикат один — по выражению id, без своей копии', () => {
    expect(notWithdrawnSql('x.id')).toContain('w.ark_id = x.id');
    expect(notWithdrawnSql('x.id')).toContain('COALESCE(wr.ark_id, wr.id) = x.id');
  });
});
