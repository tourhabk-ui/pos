import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { markupToMultiplier, multiplierToMarkup, MAX_OPERATOR_MARKUP, OPERATOR_RULE_TYPES } from '@/lib/tours/operator-discount';
import { isSatSunDate, isWeekendDate, matchPricingRules } from '@/lib/tours/pricing-rule-match';
import { removeWeekendMarkupRule, setWeekendMarkup } from '@/lib/tours/operator-markup';

// Запись наценки — дверь владельца (lib/tours/pricing-rule-door, слово владельца
// 23.11: наценка идёт на проверку). Здесь она подменена: судим, что наценка
// доходит до двери своим родом и как её исходы раскладываются по спискам.
// Саму дверь судит PostgreSQL — tests/integration/pricing-rule-moderation.pg.test.ts.
const door = vi.hoisted(() => ({ propose: vi.fn(), removeOfType: vi.fn(), removeOne: vi.fn() }));
vi.mock('@/lib/tours/pricing-rule-door', () => ({
  proposePricingRule: door.propose,
  removeRulesOfType: door.removeOfType,
  requestRuleRemoval: door.removeOne,
}));
const db = { query: vi.fn() } as never;
beforeEach(() => { door.propose.mockReset(); door.removeOfType.mockReset(); door.removeOne.mockReset(); });

describe('наценка на выходные (сб, вс) — K.ai B1', () => {
  it('предел 30%, без обрезки', () => {
    expect(MAX_OPERATOR_MARKUP).toBe(30);
    expect(markupToMultiplier(10)).toBe(1.1);
    expect(markupToMultiplier(30)).toBe(1.3);
    expect(markupToMultiplier(31)).toBeNull();
    expect(markupToMultiplier(0)).toBeNull();
    expect(markupToMultiplier(2.5)).toBeNull();
    expect(multiplierToMarkup('1.150')).toBe(15);
    expect(multiplierToMarkup(0.9)).toBeNull();
  });

  it('сб и вс — да, пт — нет; старый `weekend` (пт–вс) не тронут', () => {
    expect(isSatSunDate('2026-11-07')).toBe(true); // сб
    expect(isSatSunDate('2026-11-08')).toBe(true); // вс
    expect(isSatSunDate('2026-11-06')).toBe(false); // пт
    expect(isWeekendDate('2026-11-06')).toBe(true);
    expect(OPERATOR_RULE_TYPES).toEqual(['last_minute', 'group_discount']);
  });

  it('движок применяет наценку только на сб/вс', () => {
    const rule = { rule_type: 'weekend_sat_sun', multiplier: '1.1', is_active: true } as any;
    const ctx = (d: string) => ({ tourDate: d, guests: 1 }) as any;
    expect(matchPricingRules([rule], ctx('2026-11-07')).multiplier).toBe(1.1);
    expect(matchPricingRules([rule], ctx('2026-11-06')).multiplier).toBe(1);
  });

  it('запись: чужой тур в ответ не попадает, 31% — отказ до двери', async () => {
    door.propose.mockResolvedValue({ outcome: 'not_found' });
    expect(await setWeekendMarkup(db, 'op-1', [99], 10)).toEqual({ tours: [], pending: [] });
    door.propose.mockClear();
    await expect(setWeekendMarkup(db, 'op-1', [1], 31)).rejects.toThrow(RangeError);
    expect(door.propose).not.toHaveBeenCalled();
  });

  it('запись: наценка уходит в дверь своим родом и множителем; на проверке — в списке pending', async () => {
    door.propose
      .mockResolvedValueOnce({ outcome: 'already_live', ruleId: '1' })
      .mockResolvedValueOnce({ outcome: 'pending', ruleId: '2' })
      .mockResolvedValueOnce({ outcome: 'already_pending', ruleId: '3' })
      .mockResolvedValueOnce({ outcome: 'not_found' });
    // Повтор id не даёт второй просьбы; порядок — по id, чтобы замки не шли навстречу.
    const done = await setWeekendMarkup(db, 'op-1', [8, 5, 7, 5, 9], 15, 'user-1');
    expect(door.propose.mock.calls.map((c) => c[1])).toEqual([5, 7, 8, 9].map((tourId) => ({
      operatorId: 'op-1', requestedBy: 'user-1', tourId, ruleType: 'weekend_sat_sun', multiplier: 1.15,
    })));
    // 5 — такая наценка уже действует; 7 и 8 ждут проверки; 9 — чужой.
    expect(done).toEqual({ tours: [5, 7, 8], pending: [7, 8] });
    expect(door.removeOfType).not.toHaveBeenCalled();
  });

  it('снятие: действующая — просьбой (pending), неодобренная — сразу, чужой тур — мимо', async () => {
    door.removeOfType
      .mockResolvedValueOnce('removal_pending')
      .mockResolvedValueOnce('withdrawn')
      .mockResolvedValueOnce('none')
      .mockResolvedValueOnce('not_found');
    const done = await setWeekendMarkup(db, 'op-1', [1, 2, 3, 4], null);
    expect(door.removeOfType.mock.calls.map((c) => c[1])).toEqual([1, 2, 3, 4].map((tourId) => ({
      operatorId: 'op-1', tourId, ruleType: 'weekend_sat_sun',
    })));
    expect(done).toEqual({ tours: [1, 2, 3], pending: [1] });
    expect(door.propose).not.toHaveBeenCalled();
  });

  it('убрать одно правило — только наценку на выходные: правило другого рода этим путём не уходит', async () => {
    door.removeOne.mockResolvedValue({ outcome: 'withdrawn' });
    expect(await removeWeekendMarkupRule(db, 'op-1', '42')).toEqual({ outcome: 'withdrawn' });
    expect(door.removeOne.mock.calls[0][1]).toEqual({ operatorId: 'op-1', ruleId: '42', ruleType: 'weekend_sat_sun' });
  });

  it('миграция и базовая схема знают новый род', () => {
    expect(readFileSync('migrations/1378_pricing_rule_weekend_sat_sun.sql', 'utf8')).toMatch(/'weekend', 'weekend_sat_sun'/);
    expect(readFileSync('lib/database/baseline/schema-baseline.sql', 'utf8')).toMatch(/'weekend_sat_sun'::character varying/);
  });
});
