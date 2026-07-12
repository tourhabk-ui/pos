/**
 * Инвентаризация данных: READ-ONLY гарантия и устойчивость к ошибкам секций.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));

import { runDataInventory } from '@/lib/services/data-inventory';

describe('runDataInventory', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('шлёт только SELECT-запросы (инвентаризация ничего не меняет)', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await runDataInventory();
    expect(queryMock).toHaveBeenCalled();
    for (const call of queryMock.mock.calls) {
      const sql = String(call[0]).trim().toUpperCase();
      expect(sql.startsWith('SELECT')).toBe(true);
      expect(sql).not.toContain('UPDATE ');
      expect(sql).not.toContain('INSERT ');
      expect(sql).not.toContain('DELETE ');
    }
  });

  it('ошибка одной секции не роняет отчёт', async () => {
    let n = 0;
    queryMock.mockImplementation(() => {
      n++;
      return n === 2
        ? Promise.reject(new Error('column does not exist'))
        : Promise.resolve({ rows: [{ total: 1 }] });
    });
    const result = await runDataInventory();
    const failed = result.sections.filter(s => s.error);
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toContain('column does not exist');
    expect(result.sections.length).toBeGreaterThan(10);
  });
});
