import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { markupToMultiplier, multiplierToMarkup, MAX_OPERATOR_MARKUP, OPERATOR_RULE_TYPES } from '@/lib/tours/operator-discount';
import { isSatSunDate, isWeekendDate, matchPricingRules } from '@/lib/tours/pricing-rule-match';
import { setWeekendMarkup } from '@/lib/tours/operator-markup';

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

  it('запись: чужой тур не меняется, 31% — отказ', async () => {
    const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    expect(await setWeekendMarkup(db, 'op-1', [99], 10)).toEqual([]);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(String((db.query.mock.calls[0] as any)[0])).toMatch(/operator_id = \$2/);
    await expect(setWeekendMarkup(db, 'op-1', [1], 31)).rejects.toThrow(RangeError);
  });

  it('запись: снимает прежнюю, ставит новую', async () => {
    const sqls: string[] = [];
    const db = { query: vi.fn(async (sql: string) => { sqls.push(sql); return sql.includes('SELECT id') ? { rows: [{ id: 5 }], rowCount: 1 } : { rows: [], rowCount: 1 }; }) };
    expect(await setWeekendMarkup(db, 'op-1', [5], 15)).toEqual([5]);
    expect(sqls[1]).toMatch(/SET is_active = FALSE/);
    expect(sqls[2]).toMatch(/INSERT INTO tour_pricing_rules/);
  });

  it('миграция и базовая схема знают новый род', () => {
    expect(readFileSync('migrations/1378_pricing_rule_weekend_sat_sun.sql', 'utf8')).toMatch(/'weekend', 'weekend_sat_sun'/);
    expect(readFileSync('lib/database/baseline/schema-baseline.sql', 'utf8')).toMatch(/'weekend_sat_sun'::character varying/);
  });
});
