/**
 * tests/unit/kuzmich-accommodation-search.test.ts
 *
 * Executor инструмента Кузьмича search_accommodations (PR 5 цикла жилья):
 * прямой SELECT из accommodations по зоне/типу/цене, только is_active,
 * ORDER BY rating DESC NULLS LAST, LIMIT 6; форматирование строк со ссылкой.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const poolQueryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => poolQueryMock(sql, params) },
}));

import { searchAccommodationsForKuzmich } from '@/lib/kuzmich/accommodation-search';

beforeEach(() => {
  poolQueryMock.mockReset();
});

describe('searchAccommodationsForKuzmich', () => {
  it('без фильтров — только is_active, сортировка по рейтингу, лимит 6', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    const out = await searchAccommodationsForKuzmich({});
    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(sql).toContain('FROM accommodations');
    expect(sql).toContain('is_active = true');
    expect(sql).toContain('ORDER BY rating DESC NULLS LAST');
    expect(sql).toContain('LIMIT 6');
    expect(params).toEqual([]);
    // Условий не задавали — значит «не найдено по условиям» сказать нельзя:
    // пуста сама витрина. Разбор 20.09, образец рядом — transfer-search.
    expect(out).toMatch(/нет ни одного предложения/);
    expect(out).toMatch(/факт витрины, не сбой/);
    expect(out).not.toMatch(/по заданным условиям/);
  });

  it('фильтры zone/type/price_max — параметризованные условия по порядку', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    await searchAccommodationsForKuzmich({ zone: 'Паратунка', type: 'hotel', price_max: '8000' });
    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(sql).toContain('location_zone ILIKE $1');
    expect(sql).toContain('type ILIKE $2');
    expect(sql).toContain('price_per_night_from <= $3');
    expect(params).toEqual(['%Паратунка%', '%hotel%', 8000]);
  });

  it('нечисловой price_max игнорируется (без условия по цене)', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    await searchAccommodationsForKuzmich({ price_max: 'дорого' });
    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(sql).not.toContain('price_per_night_from <=');
    expect(params).toEqual([]);
  });

  it('фильтры не дали, но витрина не пуста — зовёт расширить запрос', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [] })          // основной отбор
      .mockResolvedValueOnce({ rows: [{ one: 1 }] }); // на витрине что-то есть
    const out = await searchAccommodationsForKuzmich({ zone: 'Налычево', price_max: '3000' });
    expect(out).toMatch(/зона «Налычево»/);
    expect(out).toMatch(/до 3000 руб\/ночь/);
    expect(out).toMatch(/есть другие варианты/);
  });

  it('фильтры не дали и витрина пуста — говорит, что дело НЕ в условиях', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const out = await searchAccommodationsForKuzmich({ type: 'glamping' });
    expect(out).toMatch(/дело не в условиях/);
    expect(out).toMatch(/факт витрины, не сбой/);
  });

  it('запрос упал — это «не смог посмотреть», а не «жилья нет»', async () => {
    // Третий исход §4.0. Отдать пустоту при отказе базы значит выдать
    // поломку за факт о витрине, и турист решит по несуществующему ответу.
    const err = Object.assign(new Error('relation "accommodations" does not exist'), { code: '42P01' });
    poolQueryMock.mockRejectedValue(err);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await searchAccommodationsForKuzmich({});
    expect(out).toMatch(/Не смог посмотреть витрину жилья/);
    expect(out).toMatch(/не «жилья нет»/);
    expect(out).not.toMatch(/нет ни одного предложения/);
    expect(spy.mock.calls.flat().join(' ')).toMatch(/42P01/);
    spy.mockRestore();
  });

  it('форматирует найденные объекты со ссылкой на карточку', async () => {
    poolQueryMock.mockResolvedValue({ rows: [
      { id: 'a1', name: 'Гостиница Гейзер', type: 'hotel', address: 'ул. Ленина 1',
        location_zone: 'Паратунка', price_per_night_from: '5500.00', rating: '4.8' },
    ] });
    const out = await searchAccommodationsForKuzmich({ zone: 'Паратунка' });
    expect(out).toContain('Гостиница Гейзер');
    expect(out).toContain('[hotel]');
    expect(out).toContain('от 5500 руб/ночь');
    expect(out).toContain('Паратунка, ул. Ленина 1');
    expect(out).toContain('/accommodations/a1');
  });
});
