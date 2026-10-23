/**
 * Витрины трансферов и проката на телефоне (владелец 23.10: «поработай над
 * ux/ul»; разбор рендером в Chromium при 390 и 1280 px). Найдено и держится
 * здесь:
 *
 *   · строка прайса перевозчика в 390 px разваливалась: «Полный день —
 *     микроавтобус» шло по слову, пометка «от» налезала на тире, «Заказать»
 *     уходила за край и страница была шире экрана. Теперь, как строка проката
 *     (#2714): ряд с переносом, полоса цены во всю ширину ниже sm;
 *   · герой прокатчика и перевозчика обрезал верх (логотип) при длинном
 *     описании: высота была задана жёстко, текст стоял поверх абсолютом.
 *     Теперь высота — минимум, текст в потоке и растит героя;
 *   · чип «Прокат · машина без водителя» в карточке списка переносился в две
 *     строки внутри «пилюли»: теперь чип одной строкой, а строка с ссылкой
 *     переносится целиком;
 *   · «Цена: за день» в полосе фактов перевозчика — без числа. Теперь
 *     числом от самой низкой строки прайса, как у проката («от 7 000 ₽ в
 *     сутки»); час и день вместе не сравнимы — словами.
 *
 * jsdom медиазапросов не считает: судятся классы и стили, которые рендер
 * отдаёт браузеру. Сами раскладки сверены в Chromium при правке.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CharterPriceList } from '@/components/transfers/CharterPriceList';
import { CarrierHero } from '@/components/transfers/CarrierHero';
import { RentalHero } from '@/components/rental/RentalHero';
import { RentalCompanyCard } from '@/components/rental/RentalCompanyCard';
import { CharterCard } from '@/components/transfers/CharterCard';
import { carrierInstrument } from '@/lib/transfers/carrier-view';
import type { CharterCarrier, CharterRate } from '@/lib/transfers/charter-format';
import type { RentalCompany } from '@/lib/rental/rental-format';

const classes = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/);
const plain = (s: string) => s.replace(/[  ]/g, ' ');

const day = (vehicleKind: string, priceRub: number): CharterRate => ({
  unit: 'day', vehicleKind, priceRub, note: 'цена «от» — точную назовёт перевозчик', conditions: null, validYear: null,
});

const CARRIER: CharterCarrier = {
  partnerId: 'p-1', slug: 'laguna-prokat', name: 'Лагуна Прокат', shortDescription: null, logo: null,
  vehicles: [{ kind: 'minibus', title: 'Ford Transit', seats: 17 }, { kind: 'vahtovka', title: 'Урал', seats: 25 }],
  seatClasses: [],
  destinations: [
    { from: 'Петропавловск-Камчатский', to: 'Вулкан Горелый', priceRub: 75000, note: null, conditions: null, validYear: 2026, place: null },
  ],
  extraDay: null,
  rates: [day('minibus', 25000), day('vahtovka', 50000)],
  photos: [], clips: [], legal: null, video: null, phone: null, telegramHref: null, whatsappHref: null,
};

describe('строка прайса перевозчика на телефоне', () => {
  it('направление и тариф: ряд с переносом, полоса цены во всю ширину ниже sm, кнопка не сжимается', () => {
    render(<CharterPriceList carrier={CARRIER} orderSlug="laguna-prokat" />);
    const buttons = screen.getAllByRole('link', { name: /^Заказать машину:/ });
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      const dd = button.closest('dd') as HTMLElement;
      expect(classes(dd)).toEqual(expect.arrayContaining(['flex', 'justify-between', 'w-full', 'sm:w-auto']));
      expect(classes(button)).toContain('shrink-0');
      const row = dd.parentElement as HTMLElement;
      expect(classes(row)).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'sm:flex-nowrap']));
      const dt = row.querySelector('dt') as HTMLElement;
      expect(classes(dt)).toEqual(expect.arrayContaining(['min-w-0', 'flex-1']));
    }
  });
});

describe('герой прокатчика и перевозчика растёт под текст', () => {
  for (const [name, Hero] of [['перевозчик', CarrierHero], ['прокатчик', RentalHero]] as const) {
    it(`${name}: высота — минимум, а не жёсткая; текст в потоке, а не абсолютом поверх`, () => {
      const { container } = render(<Hero name="Лагуна Прокат" photos={[]}><h1>Лагуна Прокат</h1></Hero>);
      const header = container.querySelector('header') as HTMLElement;
      expect(header.style.height).toBe('');
      expect(header.style.minHeight).not.toBe('');
      const h1 = screen.getByRole('heading', { level: 1 });
      // Ни один предок заголовка внутри героя не вынут из потока.
      for (let el: HTMLElement | null = h1.parentElement; el && el !== header; el = el.parentElement) {
        expect(classes(el)).not.toContain('absolute');
      }
    });
  }
});

describe('чип в карточке списка — одной строкой', () => {
  it('прокатчик и перевозчик: чип не переносится, строка с ссылкой переносится целиком', () => {
    const company: RentalCompany = {
      partnerId: 'p-1', slug: 'laguna-prokat', name: 'Лагуна Прокат', shortDescription: null, logo: null,
      photos: [], phone: null, telegramHref: null, offers: [],
    };
    const r = render(<RentalCompanyCard company={company} />);
    const chip = screen.getByText('Прокат · машина без водителя');
    expect(classes(chip)).toContain('whitespace-nowrap');
    expect(classes(chip.parentElement)).toContain('flex-wrap');
    r.unmount();

    render(<CharterCard carrier={CARRIER} />);
    const chip2 = screen.getByText('Под заказ · целая машина');
    expect(classes(chip2)).toContain('whitespace-nowrap');
    expect(classes(chip2.parentElement)).toContain('flex-wrap');
  });
});

describe('цена в полосе фактов перевозчика — числом', () => {
  const cell = (c: Pick<CharterCarrier, 'vehicles' | 'destinations' | 'rates' | 'seatClasses'>) =>
    carrierInstrument(c).find((x) => x.k === 'Цена');

  it('прайс по направлениям — от самой низкой строки за машину', () => {
    expect(plain(cell(CARRIER)!.v)).toBe('от 75 000 ₽ за машину');
  });

  it('тарифы одной единицы — от самого низкого («Лагуна»: день микроавтобуса и вахтовки)', () => {
    expect(plain(cell({ ...CARRIER, destinations: [] })!.v)).toBe('от 25 000 ₽ за день');
  });

  it('час и день вместе — словами: на одной шкале их не сравнить', () => {
    const hour: CharterRate = { ...day('minibus', 4500), unit: 'hour' };
    expect(cell({ ...CARRIER, destinations: [], rates: [hour, day('minibus', 45000)] })!.v).toBe('за час или за день');
  });

  it('прайса нет — ячейки цены нет', () => {
    expect(cell({ ...CARRIER, destinations: [], rates: [] })).toBeUndefined();
  });
});
