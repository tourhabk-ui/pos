/**
 * tests/unit/cart-checkout.test.tsx
 *
 * Чекаут корзины (/hub/tourist/cart/checkout) — корзина была декоративной:
 * из неё нельзя было оформить заказ. Контракт: заявки создаются
 * ПОСЛЕДОВАТЕЛЬНО через POST /api/hub/bookings/create; успешные удаляются
 * из корзины; 422 (NO_SLOTS и т.п.) — тур остаётся с текстом ошибки
 * сервера, повторный сабмит шлёт только его; 429 прерывает цикл;
 * кнопка заблокирована, пока не выбраны все даты.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { CartProvider } from '@/contexts/CartContext';
import CheckoutClient from '@/app/hub/tourist/cart/checkout/_CheckoutClient';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const CART = [
  { tourId: 1, title: 'Авачинский вулкан', operatorName: 'Оп1', price: 5000, activityType: 'trekking', image: null, addedAt: '2026-07-01' },
  { tourId: 2, title: 'Морская прогулка', operatorName: 'Оп2', price: 9000, activityType: 'boat_trip', image: null, addedAt: '2026-07-01' },
];

function futureDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().slice(0, 10);
}

/**
 * Базовый мок сети: /api/auth/me → гость; /slots → пусто (ручной ввод дат);
 * bookings/create — задаётся per-test через createHandler.
 */
let createHandler: (body: { tour_id: number }) => Promise<{ status: number; json: unknown }>;

function setupFetch() {
  fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
    const u = String(url);
    if (u.includes('/api/auth/me')) {
      return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ success: false }) });
    }
    if (u.includes('/slots')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, slots: [] }) });
    }
    if (u.includes('/api/hub/bookings/create')) {
      const body = JSON.parse(init!.body!) as { tour_id: number };
      return createHandler(body).then(r => ({
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: () => Promise.resolve(r.json),
      }));
    }
    return Promise.reject(new Error('unexpected fetch: ' + u));
  });
}

async function fillFormAndDates() {
  render(<CartProvider><CheckoutClient /></CartProvider>);

  fireEvent.change(screen.getByPlaceholderText('Иван Иванов'), { target: { value: 'Иван Иванов' } });
  fireEvent.change(screen.getByPlaceholderText('+7 900 000 00 00'), { target: { value: '+79991234567' } });

  // Даты: ждём ручные инпуты (slots пустые) и заполняем каждый
  await waitFor(() => {
    expect(document.querySelectorAll('input[type="date"]').length).toBeGreaterThan(0);
  });
  document.querySelectorAll('input[type="date"]').forEach(input => {
    fireEvent.change(input, { target: { value: futureDate() } });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('tourhab_cart', JSON.stringify(CART));
  setupFetch();
});

describe('Чекаут корзины', () => {
  it('кнопка заблокирована без дат, активна после заполнения', async () => {
    render(<CartProvider><CheckoutClient /></CartProvider>);

    const submit = await screen.findByRole('button', { name: /Оформить заявки/ });
    expect(submit).toBeDisabled();
  });

  it('happy-path: 2 тура → 2 последовательных POST, оба удалены из корзины, экран успеха', async () => {
    let counter = 100;
    createHandler = () => Promise.resolve({ status: 200, json: { booking_id: ++counter } });

    await fillFormAndDates();

    const submit = screen.getByRole('button', { name: /Оформить заявки/ });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByText('Заявки оформлены')).toBeInTheDocument();
    });

    const createCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('bookings/create'));
    expect(createCalls).toHaveLength(2);
    const bodies = createCalls.map(([, init]) => JSON.parse((init as { body: string }).body));
    expect(bodies.map(b => b.tour_id).sort()).toEqual([1, 2]);
    expect(bodies[0].tourist_name).toBe('Иван Иванов');
    expect(bodies[0].participants_count).toBe(1);

    // Корзина опустела
    expect(JSON.parse(localStorage.getItem('tourhab_cart') ?? '[]')).toEqual([]);
    // Ссылки на обе заявки
    expect(screen.getByText(/№101/)).toBeInTheDocument();
    expect(screen.getByText(/№102/)).toBeInTheDocument();
  });

  it('частичный успех: 422 NO_SLOTS у второго → он остаётся с ошибкой, повторный сабмит шлёт только его', async () => {
    createHandler = (body) => body.tour_id === 1
      ? Promise.resolve({ status: 200, json: { booking_id: 201 } })
      : Promise.resolve({ status: 422, json: { error: 'На выбранную дату нет свободных мест.' } });

    await fillFormAndDates();

    const submit = screen.getByRole('button', { name: /Оформить заявки/ });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByText('На выбранную дату нет свободных мест.')).toBeInTheDocument();
    });

    // Первый удалён из корзины, второй остался
    expect(JSON.parse(localStorage.getItem('tourhab_cart') ?? '[]').map((i: { tourId: number }) => i.tourId)).toEqual([2]);
    // Успех первого показан
    expect(screen.getByText(/№201/)).toBeInTheDocument();

    // Повторный сабмит: только второй тур
    createHandler = () => Promise.resolve({ status: 200, json: { booking_id: 202 } });
    fireEvent.click(screen.getByRole('button', { name: /Оформить заявки/ }));

    await waitFor(() => {
      const createCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('bookings/create'));
      expect(createCalls).toHaveLength(3);
    });
    const lastBody = JSON.parse((fetchMock.mock.calls
      .filter(([u]) => String(u).includes('bookings/create'))
      .at(-1)![1] as { body: string }).body);
    expect(lastBody.tour_id).toBe(2);
  });

  it('429 на втором → цикл прерван, честное сообщение «Оформлено 1 из 2»', async () => {
    createHandler = (body) => body.tour_id === 1
      ? Promise.resolve({ status: 200, json: { booking_id: 301 } })
      : Promise.resolve({ status: 429, json: { error: 'Слишком много запросов' } });

    await fillFormAndDates();

    const submit = screen.getByRole('button', { name: /Оформить заявки/ });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() => {
      expect(screen.getByText(/Оформлено 1 из 2/)).toBeInTheDocument();
    });
    // Второй тур остался в корзине без результата-ошибки (можно повторить через минуту)
    expect(JSON.parse(localStorage.getItem('tourhab_cart') ?? '[]').map((i: { tourId: number }) => i.tourId)).toEqual([2]);
  });

  it('единственный тур в корзине → редирект на /booking-success', async () => {
    localStorage.setItem('tourhab_cart', JSON.stringify([CART[0]]));
    createHandler = () => Promise.resolve({ status: 200, json: { booking_id: 401 } });

    await fillFormAndDates();

    const submit = screen.getByRole('button', { name: /Оформить заявки/ });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith('/booking-success/401');
    });
  });
});
