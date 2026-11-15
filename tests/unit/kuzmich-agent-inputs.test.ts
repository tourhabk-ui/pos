/**
 * Разбор 14.11, Кузьмич-13: как пишут внешние агенты — и что раньше
 * получало честный, но лишний отказ. Принимается то, что однозначно:
 *   - возраст детей «5 years old», «6岁», «6岁和10岁»;
 *   - уровень «budget», «luxury»;
 *   - дата «15.7.2027», «July 2027», «15 July 2027», «через неделю»,
 *     «в конце июля» (25-е, а не 10-е).
 * Неоднозначное по-прежнему отказ: «1.5 месяца» — не дата, «маяк» — не май,
 * голое число детей — вопрос, «через 400 дней» — не дата поездки.
 */
import { describe, it, expect } from 'vitest';
import { readChildren, readBudgetTier } from '@/lib/kuzmich/trip-plan-tool';
import { parsePlanStart } from '@/lib/kuzmich/plan-start';

const NOW = Date.parse('2026-11-14T03:00:00Z');
const startOf = (w: string) => {
  const r = parsePlanStart(w, NOW);
  return r.kind === 'parsed' ? r.date.toISOString().slice(0, 10) : r.kind;
};

describe('возраст детей', () => {
  it.each([
    ['5 years old', [5]],
    ['5 years old and 7 years old', [5, 7]],
    ['6岁', [6]],
    ['6岁和10岁', [6, 10]],
    ['6岁、10岁', [6, 10]],
  ])('%s', (raw, ages) => {
    expect(readChildren(raw, 'mcp')).toEqual({ kind: 'ages', children: ages });
  });

  it('голое число — по-прежнему вопрос, а не возраст', () => {
    expect(readChildren('6', 'mcp').kind).toBe('unknown');
  });
});

describe('уровень жилья', () => {
  it('budget — эконом, luxury — премиум', () => {
    expect(readBudgetTier('budget')).toEqual({ tier: 'economy', given: true, note: null });
    expect(readBudgetTier('luxury')).toEqual({ tier: 'premium', given: true, note: null });
  });

  it('«budget» рядом с суммой — о деньгах, а не о жилье', () => {
    expect(readBudgetTier('budget 500').given).toBe(false);
  });
});

describe('дата старта', () => {
  it.each([
    ['15.7.2027', '2027-07-15'],
    ['July 2027', '2027-07-10'],
    ['15 July 2027', '2027-07-15'],
    ['через неделю', '2026-11-21'],
    ['через 2 недели', '2026-11-28'],
    ['в конце июля', '2027-07-25'],
    ['в начале августа', '2027-08-01'],
    ['late July', '2027-07-25'],
  ])('%s → %s', (w, iso) => {
    expect(startOf(w)).toBe(iso);
  });

  it('неоднозначное — отказ', () => {
    expect(startOf('1.5 месяца')).toBe('invalid');
    expect(startOf('маяк')).toBe('invalid');
    expect(startOf('через 400 дней')).toBe('invalid');
  });
});
