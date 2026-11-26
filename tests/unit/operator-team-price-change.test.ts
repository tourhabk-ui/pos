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
import { TOUR_PRICE_FIELDS, changesTourPrice, touchesTourPrice } from '@/lib/operators/team-money';
import { MODERATED_TOUR_COLUMNS } from '@/lib/tours/moderation';
import { UpdateTourSchema } from '@/lib/api/operator-tours';

const STORED = { base_price: '12000.00', price_old: null, price_unit: 'per_person', price_note: null, title: 'Вулкан Горелый' };

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

  it('примечание к цене — тоже цена: новое или изменённое требует права, прежнее и пустое — нет', () => {
    // Турист читает примечание рядом с суммой: «Акция: 5 000 ₽ с человека» —
    // это слова о цене, и право на них даёт владелец кабинета.
    expect(TOUR_PRICE_FIELDS).toContain('price_note');
    expect(changesTourPrice({ price_note: 'Акция: 5 000 ₽ с человека' }, STORED)).toBe(true);
    expect(touchesTourPrice({ price_note: 'Акция' })).toBe(true);
    const noted = { ...STORED, price_note: 'Дети до 7 лет бесплатно' };
    expect(changesTourPrice({ price_note: 'Дети до 12 лет бесплатно' }, noted)).toBe(true);
    expect(changesTourPrice({ price_note: null }, noted)).toBe(true);
    // Форма прислала то же, что стоит, либо пустое к пустому — не правка цены.
    expect(changesTourPrice({ price_note: 'Дети до 7 лет бесплатно' }, noted)).toBe(false);
    expect(changesTourPrice({ price_note: null }, STORED)).toBe(false);
    expect(changesTourPrice({ price_note: '' }, STORED)).toBe(false);
    expect(changesTourPrice({ description: 'x' }, noted)).toBe(false);
  });

  it('каждое поле цены, которое принимает правка владельца и читает турист, охраняется правом', () => {
    // Список «что считается ценой» и список содержания не должны разойтись:
    // новая колонка о цене в очереди проверки без права на цены — тот же обход.
    const priceLike = MODERATED_TOUR_COLUMNS.filter((c) => /price/.test(c));
    expect([...priceLike].sort()).toEqual([...TOUR_PRICE_FIELDS].sort());
    for (const field of TOUR_PRICE_FIELDS) expect(Object.keys(UpdateTourSchema.shape), field).toContain(field);
  });

  it('роут тура судит по изменению против строки из базы, а не по присланному полю', () => {
    const route = readFileSync('app/api/hub/operator/tours/[id]/route.ts', 'utf8');
    // С 23.11 сверка идёт с тем, что показала форма: с витриной плюс правкой на
    // проверке (иначе менеджер без права цены не сохранил бы форму, пока чужая
    // правка цены ждёт администратора). Администратору право не спрашивается.
    expect(route).toMatch(/if \(!isAdmin\) \{[\s\S]*?if \(changesTourPrice\(input, shown\)\) \{\s*const denied = await requireTeamPermission\(authOrResponse\.userId, 'can_edit_prices'\);/);
    expect(route).not.toMatch(/touchesTourPrice\(input\)/);
    // Строка тура читается до проверки права: сравнивать есть с чем.
    expect(route.indexOf('const tour = await getTourById(tourId);')).toBeLessThan(route.indexOf('changesTourPrice(input'));
  });
});
