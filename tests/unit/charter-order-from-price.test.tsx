/**
 * Заказ машины из прайса — владелец 14.10: «а как мне забронировать например
 * на Авачинский вулкан вахтовку на 30 октября? это сложно получается».
 *
 * Было: у карточки на витрине /transfers — только «Позвонить» и мелкая ссылка
 * «Карточка перевозчика»; строка прайса открывала карточку места; форма стояла
 * внизу страницы перевозчика с первым направлением по умолчанию; кнопка
 * отправки без согласия оставалась яркой и молча не нажималась.
 *
 * Стало — судится рендером и вызовом:
 *   · у каждой строки прайса (витрина и страница) — «Заказать»: форма заявки
 *     с этим направлением; у доплаты за день — нет, это не направление;
 *   · главное действие карточки на витрине — «Заявка на машину», звонок рядом;
 *   · `?to=` выбирает строку прайса, только слово в слово: чужой текст из
 *     ссылки в заявку не попадает;
 *   · страница передаёт `?to=` форме (роут → страница → форма);
 *   · пока заявку отправить нельзя, под кнопкой сказано, чего не хватает,
 *     а сама кнопка выглядит неактивной.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';

const { loadCarrierPage } = vi.hoisted(() => ({ loadCarrierPage: vi.fn() }));
vi.mock('@/lib/database', () => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/lib/transfers/carrier-page', () => ({ loadCarrierPage: (...a: unknown[]) => loadCarrierPage(...a) }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/layout/Footer', () => ({ Footer: () => null }));
vi.stubGlobal('fetch', vi.fn());

import { CarrierPage } from '@/components/transfers/CarrierPage';
import { CharterCard } from '@/components/transfers/CharterCard';
import { charterMissing } from '@/components/transfers/CharterRequestForm';
import CarrierPageRoute from '@/app/transfers/[slug]/page';
import {
  CHARTER_REQUEST_ANCHOR, charterOrderPath, orderDestinationFromQuery, type CarrierProfile,
} from '@/lib/transfers/charter-format';
import type { CarrierPageData } from '@/lib/transfers/carrier-page';

const line = (to: string, priceRub: number, note: string | null = null) => ({
  from: 'Петропавловск-Камчатский', to, priceRub, note, conditions: 'при расчёте наличными', validYear: 2026, place: null,
});

const CARRIER: CarrierProfile = {
  partnerId: 'p-1', slug: 'shatun', name: 'Шатун', shortDescription: null, description: null, verified: true,
  vehicles: [{ kind: 'vahtovka', title: 'КамАЗ-1', seats: 26 }],
  destinations: [line('Вулкан Авачинский', 65000), line('Вулкан Горелый', 75000), line('Курильское озеро', 450000, 'плюс переправы')],
  extraDay: { priceRub: 30000, note: 'при эксплуатации транспорта на местности', conditions: null, validYear: 2026 }, rates: [],
  photos: [], clips: [], legal: null, video: null,
  phone: '+79294560102', telegramHref: 'https://t.me/+79294560102', whatsappHref: null,
};

const DATA: CarrierPageData = {
  carrier: CARRIER,
  safety: { state: 'ok', byPlace: {} },
  reviews: { state: 'ok', items: [], count: 0, average: null },
};

const form = () => document.getElementById(CHARTER_REQUEST_ANCHOR) as HTMLElement;
const picked = () => (within(form()).getByLabelText('Куда') as HTMLSelectElement).value;

beforeEach(() => {
  cleanup();
  loadCarrierPage.mockReset();
});

describe('адрес заявки', () => {
  it('форма перевозчика, с ?to= — с выбранной строкой', () => {
    expect(charterOrderPath('shatun')).toBe('/transfers/shatun#charter-request');
    expect(charterOrderPath('shatun', 'Вулкан Горелый')).toBe(
      `/transfers/shatun?to=${encodeURIComponent('Вулкан Горелый')}#charter-request`,
    );
  });

  it('?to= берётся только строкой прайса слово в слово; чужой текст — нет', () => {
    const lines = CARRIER.destinations.map((d) => d.to);
    expect(orderDestinationFromQuery(lines, 'Вулкан Горелый')).toBe('Вулкан Горелый');
    expect(orderDestinationFromQuery(lines, ' Вулкан Горелый ')).toBe('Вулкан Горелый');
    expect(orderDestinationFromQuery(lines, ['Курильское озеро', 'Вулкан Горелый'])).toBe('Курильское озеро');
    expect(orderDestinationFromQuery(lines, 'Позвоните мне на +7 900 000-00-00')).toBeNull();
    expect(orderDestinationFromQuery(lines, 'горелый')).toBeNull();
    expect(orderDestinationFromQuery(lines, undefined)).toBeNull();
    expect(orderDestinationFromQuery(lines, 42)).toBeNull();
  });
});

describe('«Заказать» у строки прайса', () => {
  it('страница перевозчика: у каждого направления — форма с ним; у доплаты за день — нет', () => {
    render(<CarrierPage data={DATA} />);
    const price = screen.getByRole('heading', { name: 'Прайс под заказ' }).parentElement as HTMLElement;
    const order = within(price).getAllByRole('link', { name: /^Заказать машину: / });
    expect(order.map((a) => a.getAttribute('href'))).toEqual(
      CARRIER.destinations.map((d) => charterOrderPath('shatun', d.to)),
    );
    expect(within(price).queryByRole('link', { name: /Доплата/ })).toBeNull();
    // Кнопка героя по-прежнему ведёт к форме (стандарт 13.10).
    expect(screen.getByRole('link', { name: /Заявка на машину/ }).getAttribute('href')).toBe(`#${CHARTER_REQUEST_ANCHOR}`);
  });

  it('витрина: главное действие — заявка на машину, «Заказать» у направлений, звонок рядом', () => {
    const { container } = render(<CharterCard carrier={CARRIER} />);
    const request = screen.getByRole('link', { name: /Заявка на машину/ });
    expect(request.getAttribute('href')).toBe('/transfers/shatun#charter-request');
    expect(screen.getAllByRole('link', { name: /^Заказать машину: / }).map((a) => a.getAttribute('href'))).toEqual(
      CARRIER.destinations.map((d) => charterOrderPath('shatun', d.to)),
    );
    // Залитая кнопка на карточке одна — заявка; звонок не спорит с ней.
    expect([...container.querySelectorAll('.ds-btn-primary')]).toEqual([request]);
    expect(container.querySelector('a[href="tel:+79294560102"]')?.className).toContain('ds-btn-secondary');
  });

  it('карточка без каналов связи — заявка всё равно есть', () => {
    render(<CharterCard carrier={{ ...CARRIER, phone: null, telegramHref: null }} />);
    expect(screen.getByRole('link', { name: /Заявка на машину/ })).toBeTruthy();
    expect(screen.getByText('Контакты перевозчика пока не записаны.')).toBeTruthy();
  });
});

describe('форма открывается с направлением из ссылки', () => {
  it('строка прайса из ?to= — выбрана; без неё — первая', () => {
    render(<CarrierPage data={DATA} orderTo="Курильское озеро" />);
    expect(picked()).toBe('Курильское озеро');
    cleanup();
    render(<CarrierPage data={DATA} />);
    expect(picked()).toBe('Вулкан Авачинский');
  });

  it('«Заказать» у другой строки на той же странице — направление меняется, введённое остаётся', () => {
    // Переход на ту же страницу с другим ?to= не создаёт форму заново сам:
    // без слежения за ссылкой выбор оставался прежним.
    const { rerender } = render(<CarrierPage data={DATA} orderTo="Вулкан Горелый" />);
    expect(picked()).toBe('Вулкан Горелый');
    fireEvent.change(within(form()).getByLabelText('Телефон'), { target: { value: '+7 900 123-45-67' } });
    fireEvent.change(within(form()).getByLabelText('Выезд'), { target: { value: '2026-10-30' } });
    rerender(<CarrierPage data={DATA} orderTo="Курильское озеро" />);
    expect(picked()).toBe('Курильское озеро');
    expect((within(form()).getByLabelText('Телефон') as HTMLInputElement).value).toBe('+7 900 123-45-67');
    expect((within(form()).getByLabelText('Выезд') as HTMLInputElement).value).toBe('2026-10-30');
  });

  it('после отправленной заявки «Заказать» у другой строки — снова форма, с новым направлением', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue({
      ok: true, json: async () => ({ success: true, data: { price_line: { to: 'Вулкан Горелый', price_rub: 75000, note: null } } }),
    } as Response);
    const { rerender } = render(<CarrierPage data={DATA} orderTo="Вулкан Горелый" />);
    const f = form();
    fireEvent.change(within(f).getByLabelText('Выезд'), { target: { value: '2026-10-30' } });
    fireEvent.change(within(f).getByLabelText('Сколько человек'), { target: { value: '4' } });
    fireEvent.change(within(f).getByLabelText('Имя и фамилия'), { target: { value: 'Иван Петров' } });
    fireEvent.change(within(f).getByLabelText('Телефон'), { target: { value: '+7 900 123-45-67' } });
    fireEvent.click(within(f).getByRole('checkbox'));
    fireEvent.click(within(f).getByRole('button', { name: /Отправить заявку на машину/ }));
    expect(await within(f).findByText(/Заявка принята/)).toBeTruthy();
    rerender(<CarrierPage data={DATA} orderTo="Курильское озеро" />);
    expect(picked()).toBe('Курильское озеро');
    expect((within(form()).getByLabelText('Имя и фамилия') as HTMLInputElement).value).toBe('Иван Петров');
    fetchMock.mockReset();
  });

  it('чужой текст в ?to= не становится «своим направлением»', () => {
    render(<CarrierPage data={DATA} orderTo="Позвоните мне" />);
    expect(picked()).toBe('Вулкан Авачинский');
    expect(within(form()).queryByLabelText('Своё направление')).toBeNull();
    expect(form().innerHTML).not.toContain('Позвоните мне');
  });

  it('роут передаёт ?to= странице и форме', async () => {
    loadCarrierPage.mockResolvedValue(DATA);
    const el = await CarrierPageRoute({
      params: Promise.resolve({ slug: 'shatun' }),
      searchParams: Promise.resolve({ to: 'Вулкан Горелый' }),
    });
    render(el);
    expect(loadCarrierPage).toHaveBeenCalledWith('shatun');
    expect(picked()).toBe('Вулкан Горелый');
  });

  it('роут без ?to= — первая строка', async () => {
    loadCarrierPage.mockResolvedValue(DATA);
    render(await CarrierPageRoute({ params: Promise.resolve({ slug: 'shatun' }) }));
    expect(picked()).toBe('Вулкан Авачинский');
  });
});

describe('чего не хватает для отправки — словами', () => {
  it('по порядку полей; всё заполнено — пусто', () => {
    const blank = { destination: 'Вулкан Авачинский', dateFrom: '', passengers: '', name: '', phone: '', pdConsent: false };
    expect(charterMissing(blank)).toEqual(['дата выезда', 'сколько человек', 'имя', 'телефон', 'согласие на обработку данных']);
    expect(charterMissing({ ...blank, destination: ' ' })[0]).toBe('куда ехать');
    expect(charterMissing({
      destination: 'Вулкан Авачинский', dateFrom: '2026-10-30', passengers: '4',
      name: 'Иван Петров', phone: '+7 900 123-45-67', pdConsent: true,
    })).toEqual([]);
    expect(charterMissing({ ...blank, passengers: '0' })).toContain('сколько человек');
  });

  it('форма: подсказка под кнопкой уходит, когда всё есть; кнопка неактивна и выглядит так', () => {
    render(<CarrierPage data={DATA} orderTo="Вулкан Авачинский" />);
    const f = form();
    const submit = within(f).getByRole('button', { name: /Отправить заявку на машину/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.className).toContain('disabled:opacity-50');
    expect(f.textContent).toContain('Чтобы отправить, осталось: дата выезда, сколько человек, имя, телефон, согласие на обработку данных.');

    fireEvent.change(within(f).getByLabelText('Выезд'), { target: { value: '2026-10-30' } });
    fireEvent.change(within(f).getByLabelText('Сколько человек'), { target: { value: '4' } });
    fireEvent.change(within(f).getByLabelText('Имя и фамилия'), { target: { value: 'Иван Петров' } });
    fireEvent.change(within(f).getByLabelText('Телефон'), { target: { value: '+7 900 123-45-67' } });
    expect(f.textContent).toContain('Чтобы отправить, осталось: согласие на обработку данных.');
    expect(submit.getAttribute('aria-describedby')).toBe('charter-missing');

    fireEvent.click(within(f).getByRole('checkbox'));
    expect(submit.disabled).toBe(false);
    expect(f.textContent).not.toContain('Чтобы отправить, осталось');
    expect(submit.getAttribute('aria-describedby')).toBeNull();
  });

  it('возвращение — не обязательно, и это сказано', () => {
    render(<CarrierPage data={DATA} />);
    const back = within(form()).getByLabelText('Возвращение');
    expect(document.getElementById(back.getAttribute('aria-describedby') ?? '')?.textContent).toBe('если не в тот же день');
    expect(form().textContent).not.toMatch(/осталось:[^.]*возвращ/i);
  });
});

describe('без JS', () => {
  it('ссылки «Заказать» — обычные адреса: работают и без клиентского перехода', () => {
    const html = renderToStaticMarkup(<CharterCard carrier={CARRIER} />);
    expect(html).toContain(`href="/transfers/shatun?to=${encodeURIComponent('Вулкан Авачинский')}#charter-request"`);
  });
});
