/**
 * tests/unit/kuzmich-gear-search.test.ts
 *
 * Executor инструмента Кузьмича search_gear: прямой SELECT из gear_items по
 * query/category/price_max, только is_active, ORDER BY rating DESC, LIMIT 6;
 * форматирование строк со ссылкой на витрину /gear.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const poolQueryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => poolQueryMock(sql, params) },
}));

import { searchGearForKuzmich } from '@/lib/kuzmich/gear-search';

beforeEach(() => poolQueryMock.mockReset());

describe('searchGearForKuzmich', () => {
  it('без фильтров — только is_active, сортировка по рейтингу, лимит 6', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    const out = await searchGearForKuzmich({});
    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(sql).toContain('FROM gear_items');
    expect(sql).toContain('is_active = true');
    expect(sql).toContain('ORDER BY rating DESC NULLS LAST');
    expect(sql).toContain('LIMIT 6');
    expect(params).toEqual([]);
    expect(out).toBe('Снаряжение по заданным условиям не найдено.');
  });

  it('query ищет по name/brand/category одним параметром', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    await searchGearForKuzmich({ query: 'палатка' });
    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(sql).toContain('name ILIKE $1 OR brand ILIKE $1 OR category ILIKE $1');
    expect(params).toEqual(['%палатка%']);
  });

  it('category + price_max — параметризованные условия по порядку', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    await searchGearForKuzmich({ category: 'палатки', price_max: '1500' });
    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(sql).toContain('category ILIKE $1');
    expect(sql).toContain('price_per_day <= $2');
    expect(params).toEqual(['%палатки%', 1500]);
  });

  it('игнорирует нечисловой price_max', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    await searchGearForKuzmich({ price_max: 'дорого' });
    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(sql).not.toContain('price_per_day <=');
    expect(params).toEqual([]);
  });

  it('форматирует найденное со ссылкой на /gear', async () => {
    poolQueryMock.mockResolvedValue({ rows: [
      { id: 'g1', name: 'Палатка 2-местная', category: 'палатки', brand: 'Alexika', price_per_day: '800', rating: '4.8' },
    ] });
    const out = await searchGearForKuzmich({ query: 'палатка' });
    expect(out).toContain('Палатка 2-местная');
    expect(out).toContain('Alexika');
    expect(out).toContain('от 800 руб/сутки');
    expect(out).toMatch(/\/gear/);
  });
});
