/**
 * tests/unit/gear-storefront.test.tsx
 *
 * Витрина аренды снаряжения (/gear) — рабочий бэкенд домена (gear_items,
 * GET /api/gear, GearBookingForm) существовал, но не имел ни одной страницы
 * и ссылки. Контракты: список из публичного API; пустой список → честный
 * empty-state; сбой API → сообщение об ошибке; «Арендовать» открывает
 * существующую форму аренды.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/gear',
}));
// Header тянет поиск/тему — не предмет теста
vi.mock('@/components/layout/Header', () => ({
  Header: () => <div data-testid="header" />,
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import GearClient from '@/app/gear/_GearClient';

const GEAR_ROW = {
  id: 'g-1',
  name: 'Палатка MSR Hubba 2',
  description: 'Двухместная',
  category: 'tent',
  subcategory: null,
  brand: 'MSR',
  price_per_day: '800',
  price_per_week: '4500',
  images: [],
  condition: 'good',
  available_quantity: 3,
  rating: '4.8',
  review_count: 12,
  partner_name: 'Камчатка Прокат',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Витрина /gear', () => {
  it('список рендерится из публичного /api/gear', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: [GEAR_ROW] }),
    });

    render(<GearClient />);

    await waitFor(() => {
      expect(screen.getByText('Палатка MSR Hubba 2')).toBeInTheDocument();
    });
    expect(screen.getByText(/Палатки · MSR · Хорошее/)).toBeInTheDocument();
    expect(screen.getByText(/800 ₽\/день/)).toBeInTheDocument();
    expect(screen.getByText('Камчатка Прокат')).toBeInTheDocument();

    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/gear');
  });

  it('пустой список → честный empty-state, не выдуманные карточки', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: [] }),
    });

    render(<GearClient />);

    await waitFor(() => {
      expect(screen.getByText(/пока не выставили снаряжение/)).toBeInTheDocument();
    });
  });

  it('сбой API → сообщение об ошибке', async () => {
    fetchMock.mockRejectedValue(new Error('network'));

    render(<GearClient />);

    await waitFor(() => {
      expect(screen.getByText(/Не удалось загрузить снаряжение/)).toBeInTheDocument();
    });
  });

  it('«Арендовать» открывает существующую форму аренды', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: [GEAR_ROW] }),
    });

    render(<GearClient />);

    const rentBtn = await screen.findByRole('button', { name: 'Арендовать' });
    fireEvent.click(rentBtn);

    await waitFor(() => {
      expect(screen.getByText(/Аренда: Палатка MSR Hubba 2/)).toBeInTheDocument();
    });
  });
});
