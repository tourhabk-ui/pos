import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { cardPrice, cardDuration } from '@/lib/tours/card-facts';

describe('компактная карточка тура: цена и срок только из данных', () => {
  it('нет цены → null (карточка пишет «Цена по запросу»), не 0 ₽', () => {
    for (const v of [null, undefined, '', '0', 0, 'abc', -5]) expect(cardPrice({ base_price: v as never })).toBeNull();
    expect(cardPrice({ base_price: '25000' })).toBe(25000);
  });
  it('нет длительности → null (плашки нет)', () => {
    expect(cardDuration({})).toBeNull();
    expect(cardDuration({ duration_type: 'multi_day', multi_day_count: null })).toBeNull();
    expect(cardDuration({ duration_hours: '0' })).toBeNull();
    expect(cardDuration({ duration_hours: '' })).toBeNull();
    expect(cardDuration({ duration_type: 'multi_day', multi_day_count: 5 })).toBe('5 дней');
    expect(cardDuration({ duration_type: 'day' })).toBe('1 день');
    expect(cardDuration({ duration_hours: '6' })).toBe('6 ч');
  });
  it('карточка: срок на фото, цена 24px, описание 1 строка, кнопка во всю ширину, «Цена по запросу»', () => {
    const src = readFileSync('components/marketplace/MarketplaceClient.tsx', 'utf8');
    expect(src).toContain('aspect-[16/10]');
    expect(src).toContain('data-testid="tour-duration-badge"');
    expect(src).toContain('text-[24px] font-semibold');
    expect(src).toContain('Цена по запросу');
    expect(src).toMatch(/line-clamp-1 mb-1\.5">\s*\{tour\.short_description/);
    expect(src).toContain('ds-btn ds-btn-primary w-full justify-center');
    expect(src).not.toMatch(/Number\(tour\.base_price\)/);
  });
});
