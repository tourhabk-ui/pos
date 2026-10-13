/**
 * Сторож: менеджер без права цен сохраняет тур, если цену не менял (CRM 2г).
 *
 * Редактор тура шлёт форму целиком — base_price приходит в каждом
 * сохранении. Право can_edit_prices судилось по присланному полю, и менеджер
 * без права цен не мог сохранить даже описание. Теперь — по изменению против
 * строки тура из базы (NUMERIC приходит строкой «12000.00»).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { changesTourPrice, touchesTourPrice } from '@/lib/operators/team-money';

const STORED = { base_price: '12000.00', price_old: null, price_unit: 'per_person', title: 'Вулкан Горелый' };

describe('цена тура: прислана ≠ изменена', () => {
  it('форма целиком с прежней ценой — не правка цены', () => {
    const form = { title: 'Вулкан Горелый', description: 'Новое описание', base_price: 12000, price_old: null, price_unit: 'per_person' };
    expect(touchesTourPrice(form)).toBe(true);
    expect(changesTourPrice(form, STORED)).toBe(false);
  });

  it('другая цена, единица цены или старая цена — правка цены', () => {
    expect(changesTourPrice({ base_price: 13000 }, STORED)).toBe(true);
    expect(changesTourPrice({ price_unit: 'per_group' }, STORED)).toBe(true);
    expect(changesTourPrice({ price_old: 15000 }, STORED)).toBe(true);
  });

  it('пустое равно пустому, но не нулю и не числу', () => {
    expect(changesTourPrice({ price_old: null }, STORED)).toBe(false);
    expect(changesTourPrice({ price_old: '' }, STORED)).toBe(false);
    expect(changesTourPrice({ price_old: 0 }, STORED)).toBe(true);
    expect(changesTourPrice({ base_price: null }, STORED)).toBe(true);
  });

  it('без полей цены — не правка цены', () => {
    expect(changesTourPrice({ description: 'x' }, STORED)).toBe(false);
  });

  it('роут тура судит по изменению против строки из базы, а не по присланному полю', () => {
    const route = readFileSync('app/api/hub/operator/tours/[id]/route.ts', 'utf8');
    expect(route).toMatch(/if \(!isAdmin && changesTourPrice\(input, tour as Record<string, unknown>\)\) \{\s*const denied = await requireTeamPermission\(authOrResponse\.userId, 'can_edit_prices'\);/);
    expect(route).not.toMatch(/touchesTourPrice\(input\)/);
    // Строка тура читается до проверки права: сравнивать есть с чем.
    expect(route.indexOf('const tour = await getTourById(tourId);')).toBeLessThan(route.indexOf('changesTourPrice(input'));
  });
});
