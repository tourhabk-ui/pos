import { describe, it, expect, vi } from 'vitest';
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
import { changeProblem, changedBase, nextSaturday, previewPriceChange, previewText } from '@/lib/crm/price-preview';

function fakeDb(rules: any[] = [], tiers: any[] = []) {
  const sqls: string[] = [];
  return { sqls, query: vi.fn(async (sql: string) => {
    sqls.push(sql);
    if (sql.includes('FROM operator_tours')) return { rows: [{ id: 7, title: 'Вулкан', base_price: '12950', price_unit: 'person' }] };
    if (sql.includes('FROM tour_pricing_rules')) return { rows: rules };
    if (sql.includes('tour_price_tiers')) return { rows: tiers };
    return { rows: [] };
  }) } as any;
}
const NOW = Date.parse('2026-11-03T08:00:00Z'); // вт по Камчатке

describe('предпросмотр цен — K.ai B2', () => {
  it('пределы', () => {
    expect(changeProblem({ kind: 'weekend_markup', percent: 31, tourIds: 'all' })).toMatch(/30/);
    expect(changeProblem({ kind: 'weekend_markup', percent: 30, tourIds: 'all' })).toBeNull();
    expect(changeProblem({ kind: 'base_price', percent: 0, tourIds: 'all' })).toMatch(/базовой/);
    expect(changeProblem({ kind: 'base_price', percent: -10, tourIds: [] })).toMatch(/ни один/);
  });
  it('база без округления', () => {
    expect(changedBase(12950, 10)).toBe(14245);
    expect(changedBase(999, 7)).toBe(1068.93);
  });
  it('суббота по Камчатке', () => {
    expect(nextSaturday(NOW)).toBe('2026-11-07');
    expect(nextSaturday(Date.parse('2026-11-06T13:00:00Z'))).toBe('2026-11-07'); // уже сб на Камчатке
  });
  it('наценка: только чтение, цена — движком', async () => {
    const db = fakeDb();
    const p = await previewPriceChange('op', { kind: 'weekend_markup', percent: 10, tourIds: 'all' }, NOW, db);
    expect(db.sqls.every((s: string) => !/\b(INSERT|UPDATE|DELETE)\b/.test(s))).toBe(true);
    expect(p.tours[0]).toMatchObject({ baseBefore: 12950, baseAfter: 12950, saturdayBefore: 12950 });
    expect(p.tours[0].saturdayAfter).toBeGreaterThan(12950);
    expect(previewText(p)).toContain('Наценка на выходные (сб, вс): +10%');
  });
  it('поднять базу на 10%', async () => {
    const p = await previewPriceChange('op', { kind: 'base_price', percent: 10, tourIds: 'all' }, NOW, fakeDb());
    expect(p.tours[0]).toMatchObject({ baseAfter: 14245, saturdayAfter: 14245 });
    expect(previewText(p)).toContain('база 12 950 ₽ → 14 245 ₽');
  });
  it('ступени — предупреждение', async () => {
    const p = await previewPriceChange('op', { kind: 'base_price', percent: 10, tourIds: 'all' }, NOW,
      fakeDb([], [{ min_people: 1, max_people: null, price_per_person: '10000' }]));
    expect(previewText(p)).toContain('цены по размеру группы');
  });
});
