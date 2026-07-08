/**
 * tests/unit/stay-review-moderation.test.ts
 *
 * Модерация отзывов о жилье (admin). Ключевой момент корректности: при
 * СКРЫТИИ триггер trg_update_accommodation_rating не срабатывает
 * (WHEN NEW.is_visible=true), поэтому роут обязан пересчитать рейтинг
 * объекта явно — иначе скрытый отзыв остаётся в средней оценке.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const clientQueryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  transaction: (cb: (c: { query: (...a: unknown[]) => unknown }) => unknown) =>
    cb({ query: (...a: unknown[]) => clientQueryMock(...a) }),
}));

const requireAdminMock = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  requireAdmin: (...args: unknown[]) => requireAdminMock(...args),
}));

import { POST as moderate } from '@/app/api/admin/content/accommodation-reviews/[id]/moderate/route';

const REVIEW_ID = '33333333-3333-3333-8333-333333333333';
const ACC_ID = '44444444-4444-4444-8444-444444444444';

function req(body: unknown): NextRequest {
  return new Request(`http://localhost/api/admin/content/accommodation-reviews/${REVIEW_ID}/moderate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }) as unknown as NextRequest;
}
const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  clientQueryMock.mockReset();
  requireAdminMock.mockReset();
  requireAdminMock.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
});

describe('POST accommodation-reviews/[id]/moderate', () => {
  it('hide → is_visible=false + ЯВНЫЙ пересчёт рейтинга объекта', async () => {
    clientQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('UPDATE accommodation_reviews')) return Promise.resolve({ rows: [{ accommodation_id: ACC_ID }] });
      if (sql.includes('UPDATE accommodations')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });
    const res = await moderate(req({ action: 'hide' }), routeParams(REVIEW_ID));
    expect(res.status).toBe(200);

    const updReview = clientQueryMock.mock.calls.find(([s]) => String(s).includes('UPDATE accommodation_reviews'))!;
    expect(updReview[1][0]).toBe(false); // is_visible = false

    const recalc = clientQueryMock.mock.calls.find(([s]) => String(s).includes('UPDATE accommodations'));
    expect(recalc).toBeTruthy();                  // пересчёт обязателен на скрытии
    expect(recalc![1]).toEqual([ACC_ID]);
    expect(String(recalc![0])).toContain('is_visible = true'); // считаем только видимые
  });

  it('show → is_visible=true + пересчёт', async () => {
    clientQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('UPDATE accommodation_reviews')) return Promise.resolve({ rows: [{ accommodation_id: ACC_ID }] });
      if (sql.includes('UPDATE accommodations')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });
    const res = await moderate(req({ action: 'show' }), routeParams(REVIEW_ID));
    expect(res.status).toBe(200);
    const updReview = clientQueryMock.mock.calls.find(([s]) => String(s).includes('UPDATE accommodation_reviews'))!;
    expect(updReview[1][0]).toBe(true);
  });

  it('несуществующий отзыв → 404, пересчёт не запускается', async () => {
    clientQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('UPDATE accommodation_reviews')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });
    const res = await moderate(req({ action: 'hide' }), routeParams(REVIEW_ID));
    expect(res.status).toBe(404);
    expect(clientQueryMock.mock.calls.some(([s]) => String(s).includes('UPDATE accommodations'))).toBe(false);
  });

  it('неверное действие → 400', async () => {
    const res = await moderate(req({ action: 'burn' }), routeParams(REVIEW_ID));
    expect(res.status).toBe(400);
    expect(clientQueryMock).not.toHaveBeenCalled();
  });

  it('кривой id → 400', async () => {
    const res = await moderate(req({ action: 'hide' }), routeParams('xxx'));
    expect(res.status).toBe(400);
  });

  it('не админ → проброс ответа requireAdmin (403)', async () => {
    requireAdminMock.mockResolvedValue(NextResponse.json({ success: false }, { status: 403 }));
    const res = await moderate(req({ action: 'hide' }), routeParams(REVIEW_ID));
    expect(res.status).toBe(403);
    expect(clientQueryMock).not.toHaveBeenCalled();
  });
});
