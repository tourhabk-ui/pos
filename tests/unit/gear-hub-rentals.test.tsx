/**
 * tests/unit/gear-hub-rentals.test.tsx
 *
 * Кабинет проката снаряжения, страница «Аренды» (_RentalsClient):
 * - список заявок из GET /api/gear/rentals (реальный API, не моки данных);
 * - кнопка перехода шлёт PATCH /api/gear/rentals/[id] с новым статусом;
 * - пустой список → честный empty-state; сбой API → сообщение об ошибке.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import RentalsClient from '@/app/hub/gear/rentals/_RentalsClient';

const RENTAL_ROW = {
  id: 'r-1',
  gear_name: 'Палатка MSR Hubba 2',
  gear_category: 'tent',
  customer_name: 'Иван Петров',
  customer_email: 'ivan@x.ru',
  customer_phone: '+79990001122',
  start_date: '2099-08-01',
  end_date: '2099-08-04',
  quantity: 1,
  days_count: 3,
  total_price: '2400',
  comments: null,
  status: 'pending',
  created_at: '2099-07-20T10:00:00Z',
};

function mockListResponse(rentals: unknown[]) {
  return {
    ok: true,
    json: () => Promise.resolve({ success: true, data: { rentals, count: rentals.length } }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Кабинет gear: заявки на аренду', () => {
  it('список рендерится из GET /api/gear/rentals', async () => {
    fetchMock.mockResolvedValue(mockListResponse([RENTAL_ROW]));

    render(<RentalsClient />);

    await waitFor(() => {
      expect(screen.getByText('Палатка MSR Hubba 2')).toBeInTheDocument();
    });
    // «Ожидает» есть и в option фильтра, и в бейдже карточки
    expect(screen.getAllByText('Ожидает')).toHaveLength(2);
    expect(screen.getByText(/Иван Петров/)).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/gear/rentals');
  });

  it('«Подтвердить» шлёт PATCH /api/gear/rentals/[id] со статусом confirmed', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: {} }) });
      }
      return Promise.resolve(mockListResponse([RENTAL_ROW]));
    });

    render(<RentalsClient />);

    const confirmBtn = await screen.findByRole('button', { name: 'Подтвердить' });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
      expect(patchCall).toBeDefined();
      expect(String(patchCall![0])).toContain('/api/gear/rentals/r-1');
      expect(JSON.parse(String((patchCall![1] as RequestInit).body))).toEqual({ status: 'confirmed' });
    });
  });

  it('ошибка перехода (422) показывается пользователю', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ success: false, error: 'Переход из статуса «completed» в «active» невозможен' }),
        });
      }
      return Promise.resolve(mockListResponse([RENTAL_ROW]));
    });

    render(<RentalsClient />);

    const confirmBtn = await screen.findByRole('button', { name: 'Подтвердить' });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(screen.getByText(/невозможен/)).toBeInTheDocument();
    });
  });

  it('пустой список → честный empty-state', async () => {
    fetchMock.mockResolvedValue(mockListResponse([]));

    render(<RentalsClient />);

    await waitFor(() => {
      expect(screen.getByText(/Заявок на аренду пока нет/)).toBeInTheDocument();
    });
  });

  it('сбой API → сообщение об ошибке', async () => {
    fetchMock.mockRejectedValue(new Error('network'));

    render(<RentalsClient />);

    await waitFor(() => {
      expect(screen.getByText(/Не удалось загрузить заявки/)).toBeInTheDocument();
    });
  });
});
