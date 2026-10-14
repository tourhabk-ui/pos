/**
 * Фото первой карточки витрины /catalog грузится сразу, остальные — лениво
 * (14.10) — рендером витрины с настоящим next/image (правило 13.10).
 *
 * Прогон 9 переписи (Lighthouse, мобильный профиль): элемент LCP витрины на
 * телефоне — фото первой карточки тура, а next/image по умолчанию грузит его
 * лениво. LCP 3,6 с, из них 2,1 с — задержка загрузки: браузер ждал, пока
 * раскладка решит, видна ли картинка. Первая карточка получает `priority`
 * (сразу и с высоким приоритетом), прочие остаются ленивыми — иначе экономия
 * на первом экране обернулась бы загрузкой всей ленты разом.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/catalog',
}));
vi.mock('@/lib/auth/session-state', () => ({ sessionState: () => Promise.resolve(false) }));

import MarketplaceClient from '@/components/marketplace/MarketplaceClient';

afterEach(cleanup);

type Tour = NonNullable<React.ComponentProps<typeof MarketplaceClient>['initialTours']>[number];
const DAY = 86_400_000;
const iso = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const tour = (over: Partial<Tour>): Tour => ({
  id: 1, slug: 'a', title: 'Тур', description: 'Полное описание тура', short_description: null,
  base_price: 25000, price_old: null, price_unit: 'per_person', activity_type: 'fishing', location_type: 'river',
  location_name: 'Река Быстрая', tour_image: '/images/activities/fishing.jpg', operator_name: 'Камчатская рыбалка',
  operator_id: 'p1', operator_verified: null, operator_slug: 'fishingkam', operator_public: true, bookings_count: 0,
  duration_hours: 10, duration_type: 'single_day', multi_day_count: null, difficulty: 'easy', included: null,
  season_start: iso(-30), season_end: iso(60), has_availability: false,
  ...over,
});
const TOURS: Tour[] = [
  tour({ id: 1, slug: 'a', title: 'Зимняя рыбалка: февраль — апрель' }),
  tour({ id: 2, slug: 'b', title: 'Сплав по Быстрой' }),
  tour({ id: 3, slug: 'c', title: 'Морская прогулка' }),
];
const KEY = JSON.stringify({ search: '', activityFilter: '', sort: 'recommended', difficulty: '', priceRange: '', durationType: '' });

function photo(title: string): HTMLImageElement {
  return screen.getByRole('img', { name: title }) as HTMLImageElement;
}

describe('витрина: фото первой карточки — первый экран', () => {
  it('первая карточка грузится сразу и с высоким приоритетом', () => {
    render(<MarketplaceClient initialTours={TOURS} initialTotal={TOURS.length} initialKey={KEY} summary={null} />);
    const first = photo('Зимняя рыбалка: февраль — апрель');
    expect(first.getAttribute('loading')).not.toBe('lazy');
    expect(first.getAttribute('fetchpriority')).toBe('high');
  });

  it('остальные карточки — лениво: лента не грузится разом', () => {
    render(<MarketplaceClient initialTours={TOURS} initialTotal={TOURS.length} initialKey={KEY} summary={null} />);
    for (const title of ['Сплав по Быстрой', 'Морская прогулка']) {
      const img = photo(title);
      expect(img.getAttribute('loading'), title).toBe('lazy');
      expect(img.getAttribute('fetchpriority'), title).not.toBe('high');
    }
  });
});
