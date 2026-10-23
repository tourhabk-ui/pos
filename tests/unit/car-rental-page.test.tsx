/**
 * Витрина /car-rental — аренда автомобилей: машина без водителя за сутки
 * (решение владельца 23.10 «пока берем аренду автомобилей и трансфер», схема
 * 1317). Судится рендером — тем, что видит человек:
 *
 *   · прокатчики с прайсом — три исхода: есть / нет — словами / не прочитались
 *     — «сбой, это не значит, что их нет»;
 *   · порядок назван на странице: «Место в списке не продаётся» (§0);
 *   · блоки по порядку: машины → как заказать → Кузьмич;
 *   · «как заказать» называет логику проката: цена за сутки за машину,
 *     «Заказать» у машины ведёт в заявку с выбранной машиной, менеджер
 *     подтверждает, расчёт напрямую; ссылка на трансферы — для машины с
 *     водителем;
 *   · «за место» и «за человека» на витрине нет;
 *   · «Заказать» у строки прайса ведёт на rentalOrderPath с машиной;
 *   · шапка — одна строка сути на телефоне, подробности с sm;
 *   · страница: отказ базы — «не смогли проверить» и код в логе.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/shared/BottomNav', () => ({ default: () => null }));
const companies = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@/lib/rental/rental', async () => {
  const format = await vi.importActual<typeof import('@/lib/rental/rental-format')>('@/lib/rental/rental-format');
  return { ...format, loadRentalCompanies: () => companies.load() };
});

import { CarRentalPage } from '@/components/rental/CarRentalPage';
import CarRentalRoute from '@/app/car-rental/(list)/page';
import { rentalOrderPath, type RentalCompany, type RentalOffer } from '@/lib/rental/rental-format';

const offer = (over: Partial<RentalOffer> = {}): RentalOffer => ({
  id: 'o-1', title: 'Toyota Land Cruiser Prado', bodyKind: 'suv', seats: 5, transmission: 'automatic', drive: '4wd',
  engineHp: null, priceRubPerDay: 7000, priceIsFrom: false, depositRub: 30000, driver: 'optional',
  conditions: null, sourceUrl: null, pricesSeenOn: null, photo: null, ...over,
});

const LAGUNA: RentalCompany = {
  partnerId: 'p-1', slug: 'laguna', name: 'Лагуна Прокат', shortDescription: 'Внедорожники и микроавтобусы без водителя',
  photos: [], phone: '+79001234567', telegramHref: null,
  offers: [
    offer(),
    offer({ id: 'o-2', title: 'ГАЗ Соболь', bodyKind: 'minibus', seats: null, transmission: 'manual', drive: null, priceRubPerDay: 25000, priceIsFrom: true, depositRub: null, driver: 'self' }),
  ],
};

const headings = (c: HTMLElement) => [...c.querySelectorAll('h2')].map((h) => h.textContent?.trim());
/** Текст без неразрывных пробелов: formatRub ставит NBSP между разрядами и перед ₽, сравнение — по смыслу. */
const txt = (el: HTMLElement | null | undefined) => (el?.textContent ?? '').replace(/\u00a0/g, ' ');

describe('витрина проката: три исхода и порядок', () => {
  it('прокатчик с прайсом; подпись про порядок; блоки по порядку', () => {
    const { container } = render(<CarRentalPage rental={{ state: 'ok', companies: [LAGUNA] }} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Аренда автомобилей');
    expect(headings(container).slice(0, 3)).toEqual(['Машины напрокат', 'Как заказать', 'Спросить Кузьмича']);
    expect(container.textContent).toContain('Место в списке не продаётся');
    expect(container.textContent).toContain('Лагуна Прокат');
    expect(container.textContent).not.toMatch(/за место|за человека/);
  });

  it('прокатчиков нет — словами; не прочитались — «сбой, это не значит, что их нет»', () => {
    const { unmount } = render(<CarRentalPage rental={{ state: 'ok', companies: [] }} />);
    expect(screen.getByText('Прокатчиков с прайсом пока нет.')).toBeTruthy();
    expect(screen.queryByText(/Место в списке не продаётся/)).toBeNull();
    unmount();
    render(<CarRentalPage rental={{ state: 'failed' }} />);
    expect(screen.getByText('Не смогли проверить прокат автомобилей')).toBeTruthy();
    expect(screen.getByText(/Это не значит, что их нет/)).toBeTruthy();
  });

  it('«как заказать» — логика проката: цена за сутки, «Заказать» у машины, менеджер, расчёт напрямую; ссылка на трансферы', () => {
    render(<CarRentalPage rental={{ state: 'ok', companies: [] }} />);
    const how = screen.getByRole('heading', { name: 'Как заказать' }).parentElement as HTMLElement;
    const steps = within(how).getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(steps).toHaveLength(3);
    expect(steps[0]).toContain('за сутки за машину без водителя');
    expect(steps[0]).toContain('«от» значит, что точную назовёт он сам');
    expect(steps[1]).toContain('Нажмите «Заказать» у машины');
    expect(steps[1]).toContain('машина уже выбрана');
    expect(steps[2]).toContain('Менеджер Ведара подтвердит машину с прокатчиком');
    expect(steps[2]).toContain('через платформу машина не оплачивается');
    expect(within(how).getByRole('link', { name: 'трансферы' }).getAttribute('href')).toBe('/transfers');
  });

  it('шапка: на телефоне одна строка сути, подробности — только с sm', () => {
    render(<CarRentalPage rental={{ state: 'ok', companies: [] }} />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.className).toContain('text-[28px]');
    expect(h1.className).not.toMatch(/\bds-h1\b/);
    const lead = h1.nextElementSibling as HTMLElement;
    expect(lead.textContent).toContain('Машина без водителя — по прайсу прокатчика, цена за сутки за машину.');
    const more = lead.querySelector('span.hidden') as HTMLElement;
    expect(more.className).toContain('sm:inline');
    expect(more.textContent).toContain('заявку менеджер Ведара подтверждает с прокатчиком');
  });
});

describe('карточка прокатчика: строки машин и путь к заявке', () => {
  it('у каждой машины — факты только записанные, цена за сутки, водитель словами, залог если записан, «Заказать» с машиной', () => {
    render(<CarRentalPage rental={{ state: 'ok', companies: [LAGUNA] }} />);
    const card = screen.getByRole('region', { name: 'Лагуна Прокат: прокат автомобилей' });
    expect(within(card).getByRole('link', { name: 'Лагуна Прокат' }).getAttribute('href')).toBe('/car-rental/laguna');
    const text = txt(card);
    expect(text).toContain('внедорожник · 5 мест · автомат · 4WD');
    expect(text).toContain('7 000 ₽/сутки');
    expect(text).toContain('без водителя или с водителем — цена водителя отдельно');
    expect(text).toContain('залог 30 000 ₽');
    expect(text).toContain('микроавтобус · число мест не записано · механика');
    expect(text).toContain('от 25 000 ₽/сутки');
    // Залог второй машины не записан — слова «залог» рядом с ней нет, и ноль не выдуман.
    expect((text.match(/залог/g) ?? []).length).toBe(1);
    expect(text).not.toContain('залог 0');
    expect(within(card).getByRole('link', { name: 'Заказать машину: Toyota Land Cruiser Prado' }).getAttribute('href'))
      .toBe(rentalOrderPath('laguna', 'Toyota Land Cruiser Prado'));
    expect(within(card).getByRole('link', { name: 'Заказать машину: ГАЗ Соболь' }).getAttribute('href'))
      .toBe('/car-rental/laguna?car=%D0%93%D0%90%D0%97%20%D0%A1%D0%BE%D0%B1%D0%BE%D0%BB%D1%8C#rental-request');
    expect(within(card).getByRole('link', { name: /Заявка на машину/ }).getAttribute('href')).toBe(rentalOrderPath('laguna'));
    expect(card.querySelector('a[href="tel:+79001234567"]')).not.toBeNull();
    // Чего на платформе не записано — сказано словами, не выдумано.
    expect(text).toContain('Минимальный срок аренды, возраст и стаж водителя, что входит в цену и страховка на платформе не записаны');
  });

  it('без контактов — сказано, что заявка дойдёт через менеджера; без фото карточка начинается с текста', () => {
    const { container } = render(<CarRentalPage rental={{ state: 'ok', companies: [{ ...LAGUNA, phone: null }] }} />);
    expect(container.textContent).toContain('Контакты прокатчика пока не записаны');
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('страница: данные', () => {
  it('отказ чтения прокатчиков — «не смогли проверить» и строка с кодом в логе, а не «прокатчиков нет»', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    companies.load.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '57P01' }));
    render(await CarRentalRoute());
    expect(screen.getByText('Не смогли проверить прокат автомобилей')).toBeTruthy();
    expect(err).toHaveBeenCalledWith('[car-rental]', '57P01', 'boom');
    err.mockRestore();
  });

  it('прокатчики прочитались — карточки на месте', async () => {
    companies.load.mockResolvedValueOnce([LAGUNA]);
    render(await CarRentalRoute());
    expect(screen.getByRole('region', { name: 'Лагуна Прокат: прокат автомобилей' })).toBeTruthy();
  });
});
