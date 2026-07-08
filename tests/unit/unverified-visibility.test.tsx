/**
 * tests/unit/unverified-visibility.test.tsx
 *
 * Честная видимость неверифицированных объектов (цикл «витрина жилья», PR 3):
 * - листинг отдаёт isVerified и сортирует проверенные первыми (не скрывая);
 * - карточка рендерит бейдж «Новый объект» / «Проверено»;
 * - клиент листинга читает реальный контракт API
 *   (data.accommodations + pagination, не data.data/meta).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: (props: { src: string; alt: string }) => React.createElement('img', { src: props.src, alt: props.alt }),
}));

import { GET as getListing } from '@/app/api/accommodations/route';
import { AccommodationCard } from '@/components/shared/AccommodationCard';

afterEach(() => {
  cleanup();
  queryMock.mockReset();
});

const ROW = {
  id: 'a1', name: 'Дом', type: 'guesthouse', description: 'Описание дома у источников',
  short_description: null, address: 'Паратунка', coordinates: null, location_zone: null,
  star_rating: null, price_per_night_from: '5000', price_per_night_to: null, currency: 'RUB',
  amenities: [], rating: '4.5', review_count: 2, is_verified: false,
  created_at: null, partner_name: null, images: null,
};

describe('GET /api/accommodations — isVerified в листинге', () => {
  it('отдаёт isVerified и сортирует проверенные первыми', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('COUNT(*)')) return Promise.resolve({ rows: [{ total: '1' }] });
      return Promise.resolve({ rows: [ROW] });
    });

    const res = await getListing(new Request('http://localhost/api/accommodations?page=1&limit=20') as unknown as NextRequest);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data.accommodations[0].isVerified).toBe(false);

    const listSql = String(queryMock.mock.calls.find(([sql]) => String(sql).includes('ORDER BY'))![0]);
    expect(listSql).toContain('a.is_verified,');
    expect(listSql).toContain('ORDER BY a.is_verified DESC');
    // Неверифицированные НЕ скрываются — фильтра по is_verified нет
    expect(listSql).not.toContain('is_verified = true');
  });
});

describe('AccommodationCard — бейджи статуса проверки', () => {
  const BASE_PROPS = {
    id: 'a1', name: 'Дом', type: 'guesthouse', description: 'Описание',
    address: 'Паратунка',
    pricePerNight: { from: 5000, to: null, currency: 'RUB' },
    rating: 4.5, reviewCount: 2, amenities: [], images: [],
  };

  it('isVerified=false → «Новый объект»', () => {
    render(<AccommodationCard {...BASE_PROPS} isVerified={false} />);
    expect(screen.getByText('Новый объект')).toBeInTheDocument();
    expect(screen.queryByText('Проверено')).not.toBeInTheDocument();
  });

  it('isVerified=true → «Проверено»', () => {
    render(<AccommodationCard {...BASE_PROPS} isVerified={true} />);
    expect(screen.getByText('Проверено')).toBeInTheDocument();
    expect(screen.queryByText('Новый объект')).not.toBeInTheDocument();
  });

  it('без пропа — ни одного бейджа статуса (обратная совместимость)', () => {
    render(<AccommodationCard {...BASE_PROPS} />);
    expect(screen.queryByText('Проверено')).not.toBeInTheDocument();
    expect(screen.queryByText('Новый объект')).not.toBeInTheDocument();
  });
});

describe('Контракт клиента листинга', () => {
  it('клиент читает data.accommodations и pagination.total (не data.data/meta)', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync('app/accommodations/_AccommodationsClient.tsx', 'utf-8');
    expect(src).toContain('data.data.accommodations');
    expect(src).toContain('pagination');
    expect(src).not.toContain('data.meta.total');
  });
});
