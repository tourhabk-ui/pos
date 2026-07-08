/**
 * tests/unit/accommodation-detail.test.tsx
 *
 * Детальная страница жилья (цикл «витрина жилья», PR 1):
 * - клиент рендерит номера с ценами и бейдж верификации;
 * - неверифицированный объект — честный бейдж «Новый объект»;
 * - 404 от API → экран «не найден» со ссылкой на каталог;
 * - карточка листинга ведёт на /accommodations/[id], а не в 404.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import React from 'react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/accommodations/x',
}));

vi.mock('@/components/layout/Header', () => ({
  Header: () => React.createElement('div', { 'data-testid': 'header' }),
}));

vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: (props: { src: string; alt: string }) => React.createElement('img', { src: props.src, alt: props.alt }),
}));

import AccommodationDetailClient from '@/app/accommodations/[id]/_AccommodationDetailClient';

const ACC_ID = '33333333-3333-4333-8333-333333333333';

const BASE_DATA = {
  id: ACC_ID,
  name: 'Гостевой дом «У вулкана»',
  type: 'guesthouse',
  description: 'Уютный дом у термальных источников',
  address: 'Паратунка, ул. Термальная, 1',
  starRating: null,
  checkInTime: '14:00:00',
  checkOutTime: '12:00:00',
  pricePerNight: { from: 5000, to: null },
  amenities: [],
  rating: 4.8,
  reviewCount: 3,
  isVerified: true,
  images: [],
  rooms: [
    { id: 'r1', name: 'Стандарт', roomType: 'double', description: null, sizeSqm: 18, maxGuests: 2, pricePerNight: 6000 },
    { id: 'r2', name: 'Люкс', roomType: 'suite', description: null, sizeSqm: 35, maxGuests: 4, pricePerNight: 12000 },
  ],
  reviews: [],
  similar: [],
};

function mockFetch(status: number, body?: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: status === 200,
    status,
    json: () => Promise.resolve(body),
  }));
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('AccommodationDetailClient', () => {
  it('рендерит номера с ценами и бейдж «Проверено»', async () => {
    mockFetch(200, { success: true, data: BASE_DATA });
    render(<AccommodationDetailClient accommodationId={ACC_ID} />);

    await waitFor(() => {
      expect(screen.getByText('Гостевой дом «У вулкана»')).toBeInTheDocument();
    });
    expect(screen.getByText('Стандарт')).toBeInTheDocument();
    // «Люкс» дважды: имя номера + лейбл типа suite
    expect(screen.getAllByText('Люкс').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/12\s000/)).toBeInTheDocument(); // ru-RU: узкий неразрывный пробел
    expect(screen.getByText(/Проверено платформой/)).toBeInTheDocument();
  });

  it('неверифицированный объект — бейдж «Новый объект»', async () => {
    mockFetch(200, { success: true, data: { ...BASE_DATA, isVerified: false } });
    render(<AccommodationDetailClient accommodationId={ACC_ID} />);

    await waitFor(() => {
      expect(screen.getByText(/Новый объект — проверка идёт/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Проверено платформой/)).not.toBeInTheDocument();
  });

  it('404 от API → «не найден» со ссылкой на каталог', async () => {
    mockFetch(404);
    render(<AccommodationDetailClient accommodationId={ACC_ID} />);

    await waitFor(() => {
      expect(screen.getByText(/не найден или снят с публикации/)).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /К каталогу жилья/ })).toHaveAttribute('href', '/accommodations');
  });
});

describe('AccommodationCard — ссылки ведут на детальную страницу', () => {
  it('href карточки — /accommodations/[id], не /hub/stay', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('components/shared/AccommodationCard.tsx', 'utf-8');
    expect(src).toContain('/accommodations/${id}');
    expect(src).not.toContain('/hub/stay/${id}');
  });
});
