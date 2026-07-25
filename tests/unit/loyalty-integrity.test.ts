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
 *
 * Смена шва (Этап 1 «эко», миграция 772): начисления больше не пишутся в
 * loyalty_transactions напрямую — они проходят проводкой реестра. Смысл
 * проверок прежний, изменилось лишь то, ГДЕ он наблюдается: раньше в тексте
 * INSERT, теперь в аргументах ledger.emit. Дедуп тоже переехал: вместо
 * SELECT-перед-INSERT (гонка) его держит UNIQUE в БД, а вызывающий видит
 * applied: false. Сам реестр покрыт tests/unit/eco-ledger.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

const redeemMock = vi.fn();
vi.mock('@/lib/eco/ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/eco/ledger')>();
  return { ...actual, redeem: (...args: unknown[]) => redeemMock(...args) };
});

// Этап 2: единственная дверь эмиссии — award(). Квоты, гео и срок сгорания
// живут там же, поэтому и наблюдаем начисление здесь.
const awardMock = vi.fn();
vi.mock('@/lib/eco/emission', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/eco/emission')>();
  return { ...actual, award: (...args: unknown[]) => awardMock(...args) };
});

import { loyaltySystem } from '@/lib/loyalty/loyalty-system';

/** Аргумент единственного вызова award(). */
function awardArg(): { amount?: number; source: string; sourceRef: string | null; description?: string } {
  const call = awardMock.mock.calls[0];
  expect(call).toBeTruthy();
  return call[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  awardMock.mockImplementation((req: { amount?: number; source: string }) => Promise.resolve({
    ok: true,
    awarded: req.amount ?? 20,
    result: { ok: true, applied: true, id: '1' },
  }));
  redeemMock.mockResolvedValue({ ok: true, applied: true, id: '2' });
});

describe('earnPoints — множитель уровня', () => {
  function mockSpent(totalSpent: number) {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM users')) {
        return Promise.resolve({ rows: [{ total_spent: String(totalSpent) }] });
      }
      throw new Error('unexpected SQL: ' + sql);
    });
  }

  it('Новичок (×1.0): 10000 руб → 100 эко, как раньше', async () => {
    mockSpent(0);
    const res = await loyaltySystem.earnPoints('u1', 'b1', 10_000);
    expect(res.success).toBe(true);
    expect(res.pointsEarned).toBe(100);
  });

  it('Золото (×2.0, от 50000 потрачено): 10000 руб → 200 эко', async () => {
    mockSpent(50_000);
    const res = await loyaltySystem.earnPoints('u1', 'b1', 10_000);
    expect(res.pointsEarned).toBe(200);

    const arg = awardArg();
    expect(arg.amount).toBe(200);
    expect(String(arg.description)).toContain('×2');
    // Ключ идемпотентности — сама бронь: повтор не начислит дважды.
    expect(arg.sourceRef).toBe('b1');
  });

  it('Платина (×3.0, от 100000): 10000 руб → 300 эко', async () => {
    mockSpent(150_000);
    const res = await loyaltySystem.earnPoints('u1', 'b1', 10_000);
    expect(res.pointsEarned).toBe(300);
  });

  it('повторное начисление за ту же бронь: реестр отвечает duplicate, эко не выдаются', async () => {
    mockSpent(0);
    awardMock.mockResolvedValue({ ok: false, awarded: 0, reason: 'duplicate', message: 'Эко за это событие уже начислены' });
    const res = await loyaltySystem.earnPoints('u1', 'b1', 10_000);
    expect(res.pointsEarned).toBe(0);
  });
});

describe('awardPhotoBonusIfEligible — фото-бонус только после модерации', () => {
  it('одобренный отзыв с фото → +20 (source=photo, sourceRef=reviewId)', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM reviews')) return Promise.resolve({ rows: [{ user_id: 'u1' }] });
      throw new Error('unexpected SQL: ' + sql);
    });

    await loyaltySystem.awardPhotoBonusIfEligible('42');

    // Селект отзыва требует is_verified и наличие review_assets
    const reviewCall = queryMock.mock.calls.find(([sql]) =>
      String(sql).includes('FROM reviews')) as [string, unknown[]];
    expect(reviewCall[0]).toContain('is_verified = true');
    expect(reviewCall[0]).toContain('review_assets');

    const arg = awardArg();
    expect(arg.source).toBe('photo');
    expect(arg.sourceRef).toBe('42');
  });

  it('отзыв не прошёл модерацию / без фото → ничего не начисляется', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM reviews')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    await loyaltySystem.awardPhotoBonusIfEligible('42');

    expect(awardMock).not.toHaveBeenCalled();
  });

  it('повторное одобрение → дедуп в БД, второй раз не начисляется', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM reviews')) return Promise.resolve({ rows: [{ user_id: 'u1' }] });
      throw new Error('unexpected SQL: ' + sql);
    });
    awardMock.mockResolvedValue({ ok: false, awarded: 0, reason: 'duplicate', message: 'Эко за это событие уже начислены' });

    const before = await loyaltySystem.earnActivityPoints('u1', 'photo', '42');
    expect(before.pointsEarned).toBe(0);

    await loyaltySystem.awardPhotoBonusIfEligible('42');
    // Проводка запрошена, но реестр её отклонил как повтор — баланс не изменился.
    expect(awardMock.mock.calls.every(([a]) => (a as { sourceRef: string }).sourceRef === '42')).toBe(true);
  });
});

describe('redeemPoints — списание атомарно', () => {
  it('нехватка эко: отказ приходит от реестра, баланс заранее не читается', async () => {
    // Прежняя реализация сначала звала getUserLoyaltyStats, а потом отдельным
    // запросом вставляла списание — в этот зазор проходило параллельное
    // списание, и баланс уходил в минус. Контракт теперь: одна операция.
    queryMock.mockImplementation((sql: string) => {
      throw new Error('redeemPoints не должен читать БД напрямую: ' + sql);
    });
    redeemMock.mockResolvedValue({ ok: false, reason: 'insufficient_funds', message: 'Недостаточно эко на счёте' });

    const res = await loyaltySystem.redeemPoints('u1', 50, 'Скидка на тур');

    expect(res.success).toBe(false);
    expect(res.message).toContain('Недостаточно эко');
    expect(res.pointsRedeemed).toBe(0);
    expect(queryMock).not.toHaveBeenCalled();
    expect(redeemMock).toHaveBeenCalledTimes(1);
  });

  it('успешное списание возвращает ровно запрошенное', async () => {
    redeemMock.mockResolvedValue({ ok: true, applied: true, id: '7' });
    const res = await loyaltySystem.redeemPoints('u1', 50, 'Скидка на тур');
    expect(res.success).toBe(true);
    expect(res.pointsRedeemed).toBe(50);
    expect(res.discountAmount).toBe(50);
  });
});
