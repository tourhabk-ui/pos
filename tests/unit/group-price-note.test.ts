import { describe, expect, it } from 'vitest';
import { groupPriceNote } from '@/lib/tours/price-label';

const sp = (s: string | null) => s?.replace(/[\u00a0\u202f]/g, ' ') ?? null;

describe('groupPriceNote', () => {
  it('за группу: размер — места тура, оценка подписана «при полной группе»', () => {
    expect(sp(groupPriceNote(45000, 'per_tour', 14))).toBe('за группу до 14 чел.; при полной группе ≈ 3 214 ₽/чел.');
    expect(sp(groupPriceNote('196000', 'per_tour', 14))).toBe('за группу до 14 чел.; при полной группе ≈ 14 000 ₽/чел.');
  });
  it('нет мест, группа без предела или цена не за группу — ничего не выдумываем', () => {
    expect(groupPriceNote(45000, 'per_tour', null)).toBeNull();
    expect(groupPriceNote(45000, 'per_tour', 0)).toBeNull();
    expect(groupPriceNote(45000, 'per_tour', 14, true)).toBeNull();
    expect(groupPriceNote(25000, 'per_day_per_person', 14)).toBeNull();
    expect(groupPriceNote(13000, 'per_person', 14)).toBeNull();
  });
});
