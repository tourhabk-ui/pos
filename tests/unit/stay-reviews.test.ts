/**
 * tests/unit/stay-reviews.test.ts
 *
 * Отзывы о жилье гостем (PR 4 цикла «жизненный цикл брони»):
 * - без завершённой брони → 403 (защита от накрутки);
 * - валидный отзыв → 201;
 * - повтор по той же брони → 409;
 * - рейтинг вне 1-5 → 400.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

const requireAuthMock = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}));

vi.mock('@/lib/services/profanity-filter', () => ({
  containsProfanity: vi.fn().mockResolvedValue(false),
}));

import { POST } from '@/app/api/accommodations/[id]/reviews/route';

const ACC_ID = '11111111-1111-1111-8111-111111111111';
const BOOKING_ID = '22222222-2222-2222-8222-222222222222';

function req(body: unknown): NextRequest {
  return new Request(`http://localhost/api/accommodations/${ACC_ID}/reviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}
const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  queryMock.mockReset();
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue({ userId: 'guest-1', role: 'tourist' });
});

describe('POST /api/accommodations/[id]/reviews', () => {
  it('нет завершённой брони → 403', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes("status = 'completed'")) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });
    const res = await POST(req({ bookingId: BOOKING_ID, overallRating: 5 }), routeParams(ACC_ID));
    expect(res.status).toBe(403);
    // Не должно быть INSERT
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO accommodation_reviews'))).toBe(false);
  });

  it('валидный отзыв при завершённой брони → 201', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes("status = 'completed'")) return Promise.resolve({ rows: [{ '?column?': 1 }] });
      // атомарный INSERT ... WHERE NOT EXISTS — отзыва ещё нет, строка вставлена
      if (sql.includes('INSERT INTO accommodation_reviews')) {
        return Promise.resolve({ rows: [{ id: 'rev-1', created_at: '2026-07-08T00:00:00Z' }] });
      }
      throw new Error('unexpected SQL: ' + sql);
    });
    const res = await POST(
      req({ bookingId: BOOKING_ID, overallRating: 4, comment: 'Отлично' }),
      routeParams(ACC_ID)
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.id).toBe('rev-1');
    // completed-проверка скоупится по гостю и объекту
    const completedCall = queryMock.mock.calls.find(([sql]) => String(sql).includes("status = 'completed'"))!;
    expect(completedCall[1]).toEqual([BOOKING_ID, 'guest-1', ACC_ID]);
  });

  it('повтор по той же брони → 409 (атомарный INSERT вернул 0 строк)', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes("status = 'completed'")) return Promise.resolve({ rows: [{ '?column?': 1 }] });
      // WHERE NOT EXISTS не пропустил — отзыв уже есть
      if (sql.includes('INSERT INTO accommodation_reviews')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });
    const res = await POST(req({ bookingId: BOOKING_ID, overallRating: 5 }), routeParams(ACC_ID));
    expect(res.status).toBe(409);
    // INSERT содержит защиту от гонки
    const insertCall = queryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO accommodation_reviews'))!;
    expect(String(insertCall[0])).toContain('WHERE NOT EXISTS');
  });

  it('рейтинг вне 1-5 → 400, БД не трогаем', async () => {
    const res = await POST(req({ bookingId: BOOKING_ID, overallRating: 6 }), routeParams(ACC_ID));
    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('некорректный id объекта → 400', async () => {
    const res = await POST(req({ bookingId: BOOKING_ID, overallRating: 5 }), routeParams('xxx'));
    expect(res.status).toBe(400);
  });
});
