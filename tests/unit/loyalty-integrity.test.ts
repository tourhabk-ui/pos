/**
 * tests/unit/loyalty-integrity.test.ts
 *
 * Два бага системы лояльности из карты функционала:
 * 1. earnMultiplier: уровни обещают ×1.2–×3.0, но earnPoints считал
 *    amount * earnRate без множителя — «Золото» получало столько же,
 *    сколько «Новичок». Контракт: множитель уровня применяется,
 *    у «Новичка» (×1.0) поведение прежнее.
 * 2. Фото-бонус (+20) начисляется ТОЛЬКО после модерации: отзыв одобрен
 *    И к нему приложены фото (review_assets). Неодобренный/без фото —
 *    ничего не начисляется.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

import { loyaltySystem } from '@/lib/loyalty/loyalty-system';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('earnPoints — множитель уровня', () => {
  function mockSpent(totalSpent: number) {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM users')) {
        return Promise.resolve({ rows: [{ total_spent: String(totalSpent) }] });
      }
      if (sql.includes('INSERT INTO loyalty_transactions')) {
        return Promise.resolve({ rows: [] });
      }
      throw new Error('unexpected SQL: ' + sql);
    });
  }

  it('Новичок (×1.0): 10000 руб → 100 баллов, как раньше', async () => {
    mockSpent(0);
    const res = await loyaltySystem.earnPoints('u1', 'b1', 10_000);
    expect(res.success).toBe(true);
    expect(res.pointsEarned).toBe(100);
  });

  it('Золото (×2.0, от 50000 потрачено): 10000 руб → 200 баллов', async () => {
    mockSpent(50_000);
    const res = await loyaltySystem.earnPoints('u1', 'b1', 10_000);
    expect(res.pointsEarned).toBe(200);

    const insert = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO loyalty_transactions')) as [string, unknown[]];
    expect(insert[1][2]).toBe(200);
    expect(String(insert[1][4])).toContain('×2');
  });

  it('Платина (×3.0, от 100000): 10000 руб → 300 баллов', async () => {
    mockSpent(150_000);
    const res = await loyaltySystem.earnPoints('u1', 'b1', 10_000);
    expect(res.pointsEarned).toBe(300);
  });
});

describe('awardPhotoBonusIfEligible — фото-бонус только после модерации', () => {
  it('одобренный отзыв с фото → +20 (source=photo, entityId=reviewId)', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM reviews')) return Promise.resolve({ rows: [{ user_id: 'u1' }] });
      // дедуп-проверка earnActivityPoints
      if (sql.includes('SELECT id FROM loyalty_transactions')) return Promise.resolve({ rows: [] });
      if (sql.includes('INSERT INTO loyalty_transactions')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    await loyaltySystem.awardPhotoBonusIfEligible('42');

    // Селект отзыва требует is_verified и наличие review_assets
    const reviewCall = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes('FROM reviews')) as [string, unknown[]];
    expect(reviewCall[0]).toContain('is_verified = true');
    expect(reviewCall[0]).toContain('review_assets');

    const insert = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO loyalty_transactions')) as [string, unknown[]];
    expect(insert).toBeTruthy();
    expect(insert[1][2]).toBe(20);
    expect(insert[1][3]).toBe('photo');
    expect(insert[1][5]).toBe('42');
  });

  it('отзыв не прошёл модерацию / без фото → ничего не начисляется', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM reviews')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    await loyaltySystem.awardPhotoBonusIfEligible('42');

    expect(queryMock.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO loyalty_transactions'))).toBe(false);
  });

  it('повторное одобрение → дедуп, второй раз не начисляется', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM reviews')) return Promise.resolve({ rows: [{ user_id: 'u1' }] });
      if (sql.includes('SELECT id FROM loyalty_transactions')) return Promise.resolve({ rows: [{ id: 'lt_1' }] });
      throw new Error('unexpected SQL: ' + sql);
    });

    await loyaltySystem.awardPhotoBonusIfEligible('42');

    expect(queryMock.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO loyalty_transactions'))).toBe(false);
  });
});
