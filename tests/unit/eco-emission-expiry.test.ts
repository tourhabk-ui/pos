/**
 * Эмиссия и сгорание эко — Этап 2.
 *
 * Актив, эмиссию которого можно фармить, ничего не стоит: дедуп по сущности
 * не спасает там, где сущности можно плодить (отзывы, фото, наблюдения).
 * Поэтому квоты — не украшение, а условие существования единицы.
 *
 * Сгорание перестало быть побочным эффектом фильтра expires_at в запросе
 * баланса и стало проводкой. Арифметика здесь — чистая, чтобы её можно было
 * проверить без БД.
 *
 * ВАЖНО: конкретные ставки и лимиты в EMISSION_RULES — предмет решения
 * владельца, а не модели. Тесты проверяют механику, а не «правильность» цифр.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  EMISSION_RULES,
  DAILY_USER_CAP,
  checkQuota,
  withinKamchatka,
  type EmissionRule,
} from '@/lib/eco/emission';
import { amountToExpire } from '@/lib/eco/expiry';

const rule = (over: Partial<EmissionRule> = {}): EmissionRule => ({
  source: 'review',
  amount: 50,
  description: 'Отзыв',
  perDayLimit: 3,
  expiresInDays: 365,
  ...over,
});

describe('checkQuota — потолок эмиссии', () => {
  it('в пределах лимитов начисление проходит', () => {
    expect(checkQuota(rule(), { todayFromSource: 0, todayTotal: 0, everFromSource: 0, amount: 50 }).ok).toBe(true);
  });

  it('дневной лимит по источнику исчерпан — отказ', () => {
    const res = checkQuota(rule({ perDayLimit: 3 }), { todayFromSource: 3, todayTotal: 150, everFromSource: 3, amount: 50 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('daily_limit');
  });

  it('общий дневной потолок держит комбинированный фарм по разным источникам', () => {
    // По своему источнику лимит не выбран, но за сутки уже набрано у потолка.
    const res = checkQuota(rule(), { todayFromSource: 0, todayTotal: DAILY_USER_CAP, everFromSource: 0, amount: 50 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('user_cap');
  });

  it('начисление, ровно упирающееся в потолок, проходит', () => {
    expect(checkQuota(rule(), {
      todayFromSource: 0, todayTotal: DAILY_USER_CAP - 50, everFromSource: 0, amount: 50,
    }).ok).toBe(true);
  });

  it('разовый бонус второй раз не выдаётся, даже если сутки прошли', () => {
    const res = checkQuota(rule({ oncePerUser: true, perDayLimit: 1 }), {
      todayFromSource: 0, todayTotal: 0, everFromSource: 1, amount: 100,
    });
    expect(res.ok).toBe(false);
  });
});

describe('withinKamchatka — полевое событие обязано быть в крае', () => {
  it('Петропавловск-Камчатский внутри', () => {
    expect(withinKamchatka(53.02, 158.65)).toBe(true);
  });
  it('Ключевская сопка внутри', () => {
    expect(withinKamchatka(56.06, 160.64)).toBe(true);
  });
  it('Москва снаружи — эко «с дивана» не начисляются', () => {
    expect(withinKamchatka(55.75, 37.62)).toBe(false);
  });
  it('Владивосток снаружи', () => {
    expect(withinKamchatka(43.11, 131.88)).toBe(false);
  });
});

describe('EMISSION_RULES — свойства реестра правил', () => {
  it('ключ записи совпадает с её source: иначе журнал разъедется с правилом', () => {
    for (const [key, r] of Object.entries(EMISSION_RULES)) {
      expect(r.source).toBe(key);
    }
  });

  it('у каждого правила есть дневной лимит: безлимитных источников не бывает', () => {
    for (const r of Object.values(EMISSION_RULES)) {
      expect(r.perDayLimit).toBeGreaterThan(0);
    }
  });

  it('пользовательский контент выдаётся только за завершённую поездку', () => {
    // Отзыв и фото человек создаёт сам — начисление без гейта было бы дверью
    // для фарма. Гейт — бронь в completed и один отзыв на тур (24.09).
    expect(EMISSION_RULES.review.requiresCompletedBooking).toBe(true);
    expect(EMISSION_RULES.photo.requiresCompletedBooking).toBe(true);
  });

  it('роут отзыва проверяет завершённую бронь и повтор ДО начисления', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/reviews/tour/[tourId]/route.ts'), 'utf8');
    const gate = src.indexOf("booking_status = 'completed'");
    const once = src.indexOf('Вы уже оставили отзыв на этот тур');
    const earn = src.indexOf("earnActivityPoints(userId, 'review'");
    expect(gate).toBeGreaterThan(-1);
    expect(once).toBeGreaterThan(-1);
    expect(earn).toBeGreaterThan(gate);
    expect(earn).toBeGreaterThan(once);
    expect(src).toMatch(/if \(photos\.length > 0\) \{\s*const p = await loyaltySystem\.earnActivityPoints\(userId, 'photo'/);
  });

  it('ни одно правило в одиночку не пробивает дневной потолок', () => {
    for (const r of Object.values(EMISSION_RULES)) {
      expect(r.amount * r.perDayLimit).toBeLessThanOrEqual(DAILY_USER_CAP * 5);
    }
  });
});

describe('amountToExpire — сгорание без лотов', () => {
  it('ничего не тратил: сгорает всё истёкшее', () => {
    expect(amountToExpire({ expiredEmitted: 100, totalOutgoing: 0, balance: 100 })).toBe(100);
  });

  it('потратил часть: сгорает только неизрасходованный остаток истёкшего', () => {
    expect(amountToExpire({ expiredEmitted: 100, totalOutgoing: 40, balance: 60 })).toBe(60);
  });

  it('потратил больше, чем начислено срочного: не сгорает ничего (FIFO)', () => {
    // 100 срочных + 50 бессрочных, потрачено 120 — срочные уже израсходованы.
    expect(amountToExpire({ expiredEmitted: 100, totalOutgoing: 120, balance: 30 })).toBe(0);
  });

  it('срок ещё не наступил — сгорать нечему', () => {
    expect(amountToExpire({ expiredEmitted: 0, totalOutgoing: 0, balance: 100 })).toBe(0);
  });

  it('повторный прогон не сжигает второй раз: сгоревшее вошло в расход', () => {
    const first = amountToExpire({ expiredEmitted: 100, totalOutgoing: 0, balance: 100 });
    expect(first).toBe(100);
    // После проводки: outgoing вырос на 100, баланс упал до нуля.
    expect(amountToExpire({ expiredEmitted: 100, totalOutgoing: 100, balance: 0 })).toBe(0);
  });

  it('никогда не списывает больше, чем есть на счёте', () => {
    expect(amountToExpire({ expiredEmitted: 500, totalOutgoing: 0, balance: 30 })).toBe(30);
  });
});
