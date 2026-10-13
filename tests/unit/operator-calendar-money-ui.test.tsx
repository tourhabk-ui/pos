/**
 * Экран календаря оператора для команды (CRM 2г-2б): менеджеру выручку не
 * показываем ни плиткой месяца, ни суммой дня, ни окраской ячеек — сервер
 * отдаёт ему money_hidden и revenue: null. Отменить бронь — кнопка только
 * с правом отмены, как в карточке брони. Владельцу — всё, как было.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

import CalendarPageClient from '@/app/hub/operator/calendar/_CalendarPageClient';

const now = new Date();
const TODAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

const BOOKING = {
  id: 'b1', tour_title: 'Вулкан Горелый', tourist_name: 'Анна', tourist_phone: null, tourist_email: null,
  participants: 2, final_price: '15000', payment_status: 'pending', booking_status: 'confirmed',
  special_requests: null, created_at: `${TODAY}T00:00:00Z`,
};

function serve(seat: { kind: 'owner' | 'manager'; can_cancel_bookings: boolean }) {
  const manager = seat.kind === 'manager';
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.startsWith('/api/hub/operator/me')) {
      return { ok: true, json: async () => ({ success: true, data: {
        kind: seat.kind, perms: { can_edit_prices: false, can_cancel_bookings: seat.can_cancel_bookings },
      } }) };
    }
    if (url.startsWith('/api/hub/operator/bookings-calendar')) {
      return { ok: true, json: async () => ({
        success: true,
        bookings_by_date: { [TODAY]: [BOOKING] },
        availability_by_date: {},
        summary: { total: 1, new: 0, confirmed: 1, completed: 0, cancelled: 0, revenue: manager ? null : 15000 },
        money_hidden: manager,
      }) };
    }
    return { ok: false, json: async () => ({ success: false }) };
  }));
}

/** Открыть сегодняшний день: ячейка — кнопка, первая строка которой — число. */
async function openToday(container: HTMLElement) {
  await waitFor(() => expect(screen.getByText('Всего')).toBeTruthy());
  const day = String(now.getDate());
  const cell = [...container.querySelectorAll('button')].find(b => b.querySelector('span')?.textContent === day);
  expect(cell).toBeTruthy();
  fireEvent.click(cell!);
  await waitFor(() => expect(screen.getByText('Вулкан Горелый')).toBeTruthy());
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('календарь оператора: деньги и права команды', () => {
  it('менеджеру — брони без выручки и без кнопки отмены без права', async () => {
    serve({ kind: 'manager', can_cancel_bookings: false });
    const { container } = render(<CalendarPageClient />);
    await openToday(container);
    expect(screen.queryByText(/Выручка/)).toBeNull();
    expect(screen.queryByText(/15K₽/)).toBeNull();
    expect(screen.queryByText('Высокая выручка')).toBeNull();
    // Сумма самой брони — как в списке броней: её менеджер видит.
    expect(screen.getByText(/15\s*000\s*₽/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: /Отменить/ })).toBeNull());
    expect(screen.getByRole('button', { name: /Завершить/ })).toBeTruthy();
  });

  it('менеджеру с правом отмены — кнопка есть', async () => {
    serve({ kind: 'manager', can_cancel_bookings: true });
    const { container } = render(<CalendarPageClient />);
    await openToday(container);
    await waitFor(() => expect(screen.getByRole('button', { name: /Отменить/ })).toBeTruthy());
  });

  it('владельцу — выручка месяца и дня', async () => {
    serve({ kind: 'owner', can_cancel_bookings: true });
    const { container } = render(<CalendarPageClient />);
    await openToday(container);
    expect(screen.getByText('Выручка')).toBeTruthy();
    expect(screen.getByText('Выручка дня')).toBeTruthy();
    expect(screen.getByText('Высокая выручка')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Отменить/ })).toBeTruthy();
  });
});
