/**
 * Шапка карточки в списках /car-rental и /transfers (владелец 23.10, снимок с
 * телефона витрины проката): ссылка «Страница прокатчика» справа держала
 * колонку на всю высоту текстового блока, и описание прокатчика шло в половину
 * экрана; счёт машин писался «3 машин в прайсе». Судится рендером:
 *
 *   · чип и ссылка на страницу — в одной строке сверху; имя, описание и счёт
 *     машин — вне этой строки, во всю ширину карточки (у перевозчика — имя и
 *     парк);
 *   · счёт машин склоняется: 1 машина, 3 машины, 5 машин (lib/home plural).
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RentalCompanyCard } from '@/components/rental/RentalCompanyCard';
import { CharterCard } from '@/components/transfers/CharterCard';
import type { RentalCompany, RentalOffer } from '@/lib/rental/rental-format';
import type { CharterCarrier } from '@/lib/transfers/charter-format';

const offer = (i: number): RentalOffer => ({
  id: `o-${i}`, title: `Машина ${i}`, bodyKind: 'suv', seats: 5, transmission: 'automatic', drive: '4wd', engineHp: null,
  priceRubPerDay: 7000 + i, priceIsFrom: false, depositRub: null, driver: 'self', conditions: null, sourceUrl: null,
  pricesSeenOn: null, photo: null,
});

const company = (n: number): RentalCompany => ({
  partnerId: 'p-1', slug: 'laguna-prokat', name: 'Лагуна Прокат',
  shortDescription: 'Машины напрокат без водителя и микроавтобус с водителем — целой машиной за сутки.',
  logo: null, photos: [], phone: null, telegramHref: null,
  offers: Array.from({ length: n }, (_, i) => offer(i + 1)),
});

const CARRIER: CharterCarrier = {
  partnerId: 'p-1', slug: 'laguna-prokat', name: 'Лагуна Прокат',
  shortDescription: 'Микроавтобус и вахтовка с водителем', logo: null,
  vehicles: [{ kind: 'minibus', title: 'Ford Transit', seats: 17 }],
  seatClasses: [], destinations: [], extraDay: null,
  rates: [{ unit: 'day', vehicleKind: 'minibus', priceRub: 25000, note: null, conditions: null, validYear: null }],
  photos: [], clips: [], legal: null, video: null, phone: null, telegramHref: null, whatsappHref: null,
};

describe('карточка прокатчика в списке', () => {
  it('ссылка на страницу стоит в строке с чипом; описание и счёт машин — вне этой строки, во всю ширину', () => {
    const c = company(3);
    render(<RentalCompanyCard company={c} />);
    const link = screen.getByRole('link', { name: 'Страница прокатчика' });
    const row = link.parentElement as HTMLElement;
    expect(row.textContent).toContain('Прокат · машина без водителя');
    expect(row.textContent).not.toContain(c.shortDescription as string);
    expect(row.textContent).not.toContain('в прайсе');
    // Описание — сосед строки, а не её содержимое.
    const block = row.parentElement as HTMLElement;
    expect(block.textContent).toContain(c.shortDescription as string);
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Лагуна Прокат');
  });

  it('счёт машин склоняется: 1 машина, 3 машины, 5 машин, 21 машина', () => {
    for (const [n, text] of [[1, '1 машина в прайсе'], [3, '3 машины в прайсе'], [5, '5 машин в прайсе'], [21, '21 машина в прайсе']] as const) {
      const { container, unmount } = render(<RentalCompanyCard company={company(n)} />);
      expect(container.textContent).toContain(text);
      unmount();
    }
  });
});

describe('карточка перевозчика в списке', () => {
  it('ссылка на карточку стоит в строке с чипом; имя и парк — вне этой строки', () => {
    render(<CharterCard carrier={CARRIER} />);
    const link = screen.getByRole('link', { name: 'Карточка перевозчика' });
    const row = link.parentElement as HTMLElement;
    expect(row.textContent).toContain('Под заказ · целая машина');
    expect(row.textContent).not.toContain('Лагуна Прокат');
    expect(row.textContent).not.toContain('17 мест');
    const block = row.parentElement as HTMLElement;
    expect(block.textContent).toContain('микроавтобус, 17 мест');
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe('Лагуна Прокат');
  });
});
