/**
 * Скрытый модератором отзыв не попадает на публичную карточку тура.
 *
 * Миграция 878 завела `operator_tour_reviews.is_hidden`, админка его ставит,
 * а getTourReviews читала без фильтра — кнопка «Скрыть» не скрывала ничего.
 * Там же пустой catch отдавал [] — поломка читалась как «отзывов нет».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));

import { getTourReviews } from '@/lib/tours/tour-detail-query';

beforeEach(() => {
  queryMock.mockReset();
});

describe('getTourReviews', () => {
  it('в запросе есть is_hidden = FALSE', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await getTourReviews(7);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toMatch(/is_hidden\s*=\s*FALSE/i);
  });

  it('запасной запрос без photos тоже фильтрует скрытые', async () => {
    queryMock
      .mockRejectedValueOnce(Object.assign(new Error('no column photos'), { code: '42703' }))
      .mockResolvedValueOnce({ rows: [] });
    await getTourReviews(7);
    expect(String(queryMock.mock.calls[1][0])).toMatch(/is_hidden\s*=\s*FALSE/i);
  });

  it('отказ пишется в лог с именем и SQLSTATE, а не глушится', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    queryMock.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '57014' }));
    const rows = await getTourReviews(7);
    expect(rows).toEqual([]);
    const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('getTourReviews');
    expect(logged).toContain('57014');
    spy.mockRestore();
  });
});
