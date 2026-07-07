/**
 * tests/unit/stay-hub-bookings.test.tsx
 *
 * Кабинет владельца жилья, страница «Брони» (_BookingsClient):
 * - список броней из GET /api/stay/bookings;
 * - кнопка перехода шлёт PATCH /api/stay/bookings/[id] с новым статусом;
 * - 404 (нет stay-профиля) → честное объяснение, а не пустой список;
 * - пустой список → честный empty-state; сбой API → сообщение об ошибке.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import BookingsClient from '@/app/hub/stay/bookings/_BookingsClient';

const BOOKING_ROW = {
  id: 'b-1',
  accommodation_name: 'Гостиница «Вулкан»',
  room_name: 'Стандарт двухместный',
  guest_name: 'Иван Петров',
  guest_email: 'ivan@x.ru',
  check_in_date: '2099-08-01',
  check_out_date: '2099-08-04',
  nights: 3,
  adults: 2,
  children: 0,
  total_price: '15000',
  status: 'pending',
  payment_status: 'pending',
  special_requests: null,
  created_at: '2099-07-20T10:00:00Z',
};

function mockListResponse(bookings: unknown[]) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ success: true, data: { bookings, count: bookings.length } }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Кабинет stay: входящие брони', () => {
  it('список рендерится из GET /api/stay/bookings', async () => {
    fetchMock.mockResolvedValue(mockListResponse([BOOKING_ROW]));

    render(<BookingsClient />);

    await waitFor(() => {
      expect(screen.getByText(/Гостиница «Вулкан»/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Иван Петров/)).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/stay/bookings');
  });

  it('«Подтвердить» шлёт PATCH /api/stay/bookings/[id] со статусом confirmed', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: {} }) });
      }
      return Promise.resolve(mockListResponse([BOOKING_ROW]));
    });

    render(<BookingsClient />);

    const confirmBtn = await screen.findByRole('button', { name: 'Подтвердить' });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
      expect(patchCall).toBeDefined();
      expect(String(patchCall![0])).toContain('/api/stay/bookings/b-1');
      expect(JSON.parse(String((patchCall![1] as RequestInit).body))).toEqual({ status: 'confirmed' });
    });
  });

  it('confirmed показывает кнопки заезда и no-show', async () => {
    fetchMock.mockResolvedValue(mockListResponse([{ ...BOOKING_ROW, status: 'confirmed' }]));

    render(<BookingsClient />);

    expect(await screen.findByRole('button', { name: 'Заезд состоялся' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'No-show' })).toBeInTheDocument();
  });

  it('404 без stay-профиля → честное объяснение', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ success: false, error: 'Профиль владельца жилья не найден' }),
    });

    render(<BookingsClient />);

    await waitFor(() => {
      expect(screen.getByText(/Объекты подключает администратор/)).toBeInTheDocument();
    });
  });

  it('пустой список → честный empty-state', async () => {
    fetchMock.mockResolvedValue(mockListResponse([]));

    render(<BookingsClient />);

    await waitFor(() => {
      expect(screen.getByText(/Броней пока нет/)).toBeInTheDocument();
    });
  });

  it('сбой API → сообщение об ошибке', async () => {
    fetchMock.mockRejectedValue(new Error('network'));

    render(<BookingsClient />);

    await waitFor(() => {
      expect(screen.getByText(/Не удалось загрузить брони/)).toBeInTheDocument();
    });
  });
});
