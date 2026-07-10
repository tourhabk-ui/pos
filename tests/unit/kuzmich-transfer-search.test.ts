/**
 * tests/unit/kuzmich-transfer-search.test.ts
 *
 * Executor инструмента Кузьмича search_transfers: SELECT из transfer_routes
 * по from/to/price_max, только is_active, популярные и дешёвые первыми,
 * LIMIT 6; формат «откуда → куда — цена» со ссылкой на /transfers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const poolQueryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => poolQueryMock(sql, params) },
}));

import { searchTransfersForKuzmich } from '@/lib/kuzmich/transfer-search';

beforeEach(() => poolQueryMock.mockReset());

describe('searchTransfersForKuzmich', () => {
  it('без фильтров — только is_active, популярные и дешёвые первыми, лимит 6', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    const out = await searchTransfersForKuzmich({});
    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(sql).toContain('FROM transfer_routes');
    expect(sql).toContain('is_active = true');
    expect(sql).toContain('ORDER BY popular DESC, base_price ASC NULLS LAST');
    expect(sql).toContain('LIMIT 6');
    expect(params).toEqual([]);
    expect(out).toBe('Трансферы по заданному направлению не найдены.');
  });

  it('from/to/price_max — параметризованные условия по порядку', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    await searchTransfersForKuzmich({ from: 'аэропорт', to: 'Паратунка', price_max: '3000' });
    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(sql).toContain('from_location ILIKE $1');
    expect(sql).toContain('to_location ILIKE $2');
    expect(sql).toContain('base_price <= $3');
    expect(params).toEqual(['%аэропорт%', '%Паратунка%', 3000]);
  });

  it('игнорирует нечисловой price_max', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    await searchTransfersForKuzmich({ price_max: 'дёшево' });
    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(sql).not.toContain('base_price <=');
    expect(params).toEqual([]);
  });

  it('форматирует маршрут с ценой, км, часами и ссылкой', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{
      id: 't1', name: null, from_location: 'Аэропорт Елизово', to_location: 'Паратунка',
      distance_km: '38', duration_minutes: 45, base_price: '2500',
    }] });
    const out = await searchTransfersForKuzmich({ to: 'Паратунка' });
    expect(out).toContain('Аэропорт Елизово → Паратунка');
    expect(out).toContain('от 2500 руб');
    expect(out).toContain('38 км');
    expect(out).toMatch(/\/transfers/);
  });
});
