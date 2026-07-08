/**
 * tests/unit/stay-booking-flow.test.tsx
 *
 * Живая форма бронирования жилья (цикл «витрина жилья», PR 2):
 * - computeStayTotal зеркалит сервер: сумма по ночам, без множителя
 *   на гостей; blocked-дата и недогруженные ночи блокируют бронь;
 * - /prices?roomId= — приоритет override номера над объектным и
 *   базовая цена номера;
 * - RTL: выбор номера уходит в POST .../book как roomId, сумма — из
 *   реальных цен по ночам.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { NextRequest } from 'next/server';

import { computeStayTotal, listNights } from '@/lib/booking/stay-price';

// ── API prices ────────────────────────────────────────────────────────────────

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

import { GET as getPrices } from '@/app/api/accommodations/[id]/prices/route';

// ── Форма: моки тяжёлых зависимостей ─────────────────────────────────────────

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'g@x.ru' } }),
}));

vi.mock('@/components/payments/CloudPaymentsWidget', () => ({
  CloudPaymentsWidget: (props: { amount: number; invoiceId: string }) =>
    React.createElement('div', { 'data-testid': 'payment-widget' }, `pay:${props.amount}:${props.invoiceId}`),
}));

vi.mock('@/components/booking/ui/GuestSelector', () => ({
  GuestSelector: () => React.createElement('div', { 'data-testid': 'guests' }),
}));

vi.mock('@/components/booking/calendars/StayDatePicker', () => ({
  StayDatePicker: (props: { onDatesChange: (a: Date, b: Date) => void }) =>
    React.createElement(
      'button',
      {
        type: 'button',
        onClick: () => props.onDatesChange(new Date('2099-08-01T00:00:00'), new Date('2099-08-03T00:00:00')),
      },
      'выбрать даты'
    ),
}));

import { StayBookingForm } from '@/components/booking/StayBookingForm';

const ACC_ID = '33333333-3333-4333-8333-333333333333';
const ROOM_A = '55555555-5555-4555-8555-555555555555';
const ROOM_B = '66666666-6666-4666-8666-666666666666';

const ROOMS = [
  { id: ROOM_A, name: 'Стандарт', roomType: 'double', maxGuests: 2, pricePerNight: 6000 },
  { id: ROOM_B, name: 'Люкс', roomType: 'suite', maxGuests: 4, pricePerNight: 12000 },
];

function jsonReq(url: string): NextRequest {
  return new Request(url) as unknown as NextRequest;
}

beforeEach(() => {
  queryMock.mockReset();
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
});

// ── computeStayTotal ──────────────────────────────────────────────────────────

describe('computeStayTotal — зеркало серверного расчёта', () => {
  const PRICES = [
    { date: '2099-08-01', price: 6000, isBlocked: false },
    { date: '2099-08-02', price: 15000, isBlocked: false }, // override
    { date: '2099-08-03', price: 6000, isBlocked: false },
  ];

  it('сумма по ночам [in, out), без множителя на гостей', () => {
    const t = computeStayTotal(PRICES, '2099-08-01', '2099-08-03');
    expect(t.nights).toBe(2);
    expect(t.total).toBe(6000 + 15000); // ночь выезда не считается
    expect(t.blockedDate).toBeNull();
    expect(t.missingNights).toBe(0);
  });

  it('закрытая дата в диапазоне помечается', () => {
    const t = computeStayTotal(
      [{ date: '2099-08-01', price: 6000, isBlocked: true }],
      '2099-08-01', '2099-08-02'
    );
    expect(t.blockedDate).toBe('2099-08-01');
  });

  it('недогруженные ночи считаются честно, не нулём молча', () => {
    const t = computeStayTotal(PRICES, '2099-08-01', '2099-08-05');
    expect(t.missingNights).toBe(1); // 2099-08-04 нет в карте
  });

  it('listNights: полуинтервал', () => {
    expect(listNights('2099-08-01', '2099-08-03')).toEqual(['2099-08-01', '2099-08-02']);
  });
});

// ── /prices?roomId ────────────────────────────────────────────────────────────

describe('GET /prices?roomId — приоритеты уровня номера', () => {
  it('база = цена номера, JOIN обоих уровней, приоритет номера в COALESCE', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM accommodations')) {
        return Promise.resolve({ rows: [{ id: ACC_ID, name: 'Дом', price_per_night_from: '5000', is_active: true }] });
      }
      if (sql.includes('FROM accommodation_rooms')) {
        return Promise.resolve({ rows: [{ price_per_night: '9000' }] });
      }
      if (sql.includes('generate_series')) {
        return Promise.resolve({ rows: [{ date: '2099-08-01', price: '9000', has_override: false, is_blocked: false }] });
      }
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await getPrices(
      jsonReq(`http://localhost/api/accommodations/${ACC_ID}/prices?startDate=2099-08-01&endDate=2099-08-01&roomId=${ROOM_A}`),
      { params: Promise.resolve({ id: ACC_ID }) }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.basePrice).toBe(9000); // цена номера, не объекта
    expect(body.data.roomId).toBe(ROOM_A);

    const priceSql = String(queryMock.mock.calls.find(([sql]) => String(sql).includes('generate_series'))![0]);
    expect(priceSql).toContain('COALESCE(rv.price_override, av.price_override');
    expect(priceSql).toContain('rv.room_id = $5');
  });

  it('чужой/несуществующий номер → 404', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM accommodations')) {
        return Promise.resolve({ rows: [{ id: ACC_ID, name: 'Дом', price_per_night_from: '5000', is_active: true }] });
      }
      if (sql.includes('FROM accommodation_rooms')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await getPrices(
      jsonReq(`http://localhost/api/accommodations/${ACC_ID}/prices?startDate=2099-08-01&endDate=2099-08-01&roomId=${ROOM_B}`),
      { params: Promise.resolve({ id: ACC_ID }) }
    );
    expect(res.status).toBe(404);
  });
});

// ── Форма ─────────────────────────────────────────────────────────────────────

describe('StayBookingForm', () => {
  function stubFetch(bookResponse?: { status: number; body: unknown }) {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/prices')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            data: {
              prices: [
                { date: '2099-08-01', price: 6000, isBlocked: false },
                { date: '2099-08-02', price: 15000, isBlocked: false },
              ],
            },
          }),
        });
      }
      if (url.includes('/book')) {
        return Promise.resolve({
          ok: bookResponse ? bookResponse.status < 400 : true,
          status: bookResponse?.status ?? 200,
          json: () => Promise.resolve(bookResponse?.body ?? {
            success: true,
            data: {
              bookingId: 'b1',
              nights: 2,
              priceBreakdown: { totalPrice: 21000 },
              // Контракт вебхука: invoiceId = payments.id, НЕ bookingId
              payment: { paymentId: 'pay-1', invoiceId: 'invoice-77', amount: 21000 },
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
    }));
    return calls;
  }

  it('сумма — из реальных цен по ночам, roomId уходит в book', async () => {
    const calls = stubFetch();
    render(<StayBookingForm accommodationId={ACC_ID} accommodationName="Дом" rooms={ROOMS} />);

    // Даты через мок-пикер
    fireEvent.click(screen.getByText('выбрать даты'));

    await waitFor(() => {
      // 6000 + 15000 по ночам, БЕЗ умножения на гостей
      expect(screen.getByText(/21\s000/)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Забронировать' }));

    await waitFor(() => {
      expect(screen.getByText('Бронирование создано')).toBeInTheDocument();
    });

    const bookCall = calls.find(c => c.url.includes('/book'))!;
    const payload = JSON.parse(String(bookCall.init?.body));
    expect(payload.roomId).toBe(ROOM_A); // выбран первый номер по умолчанию
    expect(payload.checkInDate).toBe('2099-08-01');
    expect(payload.checkOutDate).toBe('2099-08-03');
    // Сумма к оплате — серверная; invoiceId — payments.id из ответа book
    // (вебхук CloudPayments сверяет только по нему), НЕ bookingId
    expect(screen.getByTestId('payment-widget')).toHaveTextContent('pay:21000:invoice-77');
  });

  it('book без payment (создание платежа упало) → виджета нет, честное сообщение', async () => {
    stubFetch({
      status: 200,
      body: {
        success: true,
        data: { bookingId: 'b2', nights: 2, priceBreakdown: { totalPrice: 21000 }, payment: null },
      },
    });
    render(<StayBookingForm accommodationId={ACC_ID} accommodationName="Дом" rooms={ROOMS} />);

    fireEvent.click(screen.getByText('выбрать даты'));
    await waitFor(() => expect(screen.getByText(/21\s000/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Забронировать' }));

    await waitFor(() => {
      expect(screen.getByText('Бронирование создано')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('payment-widget')).not.toBeInTheDocument();
    expect(screen.getByText(/ссылка на оплату придёт после подтверждения/)).toBeInTheDocument();
  });

  it('смена номера меняет roomId в prices-запросе', async () => {
    const calls = stubFetch();
    render(<StayBookingForm accommodationId={ACC_ID} accommodationName="Дом" rooms={ROOMS} />);

    fireEvent.click(screen.getByDisplayValue(ROOM_B));

    await waitFor(() => {
      expect(calls.some(c => c.url.includes(`roomId=${ROOM_B}`))).toBe(true);
    });
  });

  it('401 от book → подсказка войти, брони нет', async () => {
    stubFetch({ status: 401, body: { error: 'Не авторизован' } });
    render(<StayBookingForm accommodationId={ACC_ID} accommodationName="Дом" rooms={ROOMS} />);

    fireEvent.click(screen.getByText('выбрать даты'));
    await waitFor(() => expect(screen.getByText(/21\s000/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Забронировать' }));

    await waitFor(() => {
      expect(screen.getByText(/войдите в аккаунт/)).toBeInTheDocument();
    });
    expect(screen.queryByText('Бронирование создано')).not.toBeInTheDocument();
  });

  it('без номеров — честное сообщение вместо формы', () => {
    stubFetch();
    render(<StayBookingForm accommodationId={ACC_ID} accommodationName="Дом" rooms={[]} />);
    expect(screen.getByText(/владелец добавит номера/)).toBeInTheDocument();
  });
});
