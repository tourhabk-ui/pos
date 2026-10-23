/**
 * Строка прайса проката на телефоне (владелец 23.10, снимок /car-rental с
 * телефона после выката фото): четыре колонки — снимок, название с фактами,
 * цена, «Заказать» — в 360 px давили название на цену, факты шли по слову в
 * строке, кнопка уходила за край экрана.
 *
 * Правило: на узком экране строка в две полосы — снимок с названием и
 * фактами, под ними цена и «Заказать» во всю ширину; от sm — одна строка.
 * jsdom медиазапросов не считает, поэтому судится то, что рендер отдаёт
 * браузеру: у полосы цены класс полной ширины и его снятие от sm, у ряда —
 * перенос и его снятие от sm, у названия — право сжиматься. Снимок при 360 px
 * и 1024 px сверен в Chromium при правке (scratchpad, в репозиторий не входит).
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RentalOfferList } from '@/components/rental/RentalOfferList';
import { priceOnScreen, type RentalOffer } from '@/lib/rental/rental-format';

const offer = (over: Partial<RentalOffer> = {}): RentalOffer => ({
  id: 'o-1', title: 'Suzuki Jimny', bodyKind: 'suv', seats: 4, transmission: 'automatic', drive: '4wd', engineHp: 105,
  priceRubPerDay: 7000, priceIsFrom: false, depositRub: 15000, driver: 'self', conditions: null, sourceUrl: null,
  pricesSeenOn: null, photo: { url: '/images/laguna-prokat/laguna-suzuki-jimny.jpg', credit: 'Лагуна Прокат' }, ...over,
});

const classes = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/);

describe('строка прайса проката на телефоне', () => {
  it('цена и «Заказать» — своей полосой во всю ширину на узком экране, в одной строке с названием от sm', () => {
    render(<RentalOfferList orderSlug="laguna-prokat" offers={[offer()]} />);
    const button = screen.getByRole('link', { name: 'Заказать машину: Suzuki Jimny' });
    const dd = button.closest('dd') as HTMLElement;
    expect(dd.textContent).toContain(priceOnScreen(offer()));
    // Полоса цены — строкой: цена слева, «Заказать» у правого края, не под ценой.
    expect(classes(dd)).toEqual(expect.arrayContaining(['flex', 'justify-between', 'w-full', 'sm:w-auto']));
    expect(classes(button)).toContain('shrink-0');

    const row = dd.parentElement as HTMLElement;
    expect(classes(row)).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'sm:flex-nowrap']));
    const dt = row.querySelector('dt') as HTMLElement;
    expect(dt.textContent).toContain('Suzuki Jimny');
    expect(classes(dt)).toEqual(expect.arrayContaining(['min-w-0', 'flex-1']));
    // Без собственной ширины-основы: при 320 px название остаётся рядом со
    // снимком (basis-40 = 160 px выталкивало его под снимок, ревью 23.10).
    expect(classes(dt).some((c) => /^basis-/.test(c))).toBe(false);
    // Снимок не растягивается и не сжимается: ширина фиксирована.
    const photo = row.querySelector('[title="Фото: Лагуна Прокат"]') as HTMLElement;
    expect(classes(photo)).toEqual(expect.arrayContaining(['w-20', 'shrink-0']));
  });

  it('строка без снимка и без кнопки устроена так же: полоса цены во всю ширину', () => {
    const bare = offer({ photo: null, depositRub: null, priceIsFrom: true });
    const { container } = render(<RentalOfferList offers={[bare]} />);
    const dd = container.querySelector('dd') as HTMLElement;
    expect(dd.textContent).toBe(priceOnScreen(bare));
    expect(classes(dd)).toEqual(expect.arrayContaining(['w-full', 'sm:w-auto']));
    expect(dd.querySelector('a')).toBeNull();
  });
});
