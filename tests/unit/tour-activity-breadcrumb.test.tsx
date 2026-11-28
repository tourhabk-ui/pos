/**
 * Крошка «Туры → вид занятия» у тура без вида (разбор индексации 28.11).
 *
 * Ссылка собиралась как /catalog?activity_type=${tour.activity_type}, и у
 * туров без вида занятия выходило /catalog?activity_type=null: такие адреса
 * Google нашёл на карточках туров. Пустой вид — пункта крошки нет, и подписи
 * вида над названием тоже нет; вид есть — ссылка прежняя, значение
 * закодировано.
 *
 * Судит рендер карточки: что в крошках и в герое видит человек.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/catalog/tours/120',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/layout/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/marketplace/TourReviewForm', () => ({ default: () => null }));
vi.mock('@/components/marketplace/MessageOperatorButton', () => ({ default: () => null }));
vi.mock('@/components/safety/SafetyWarnings', () => ({ default: () => null }));
vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).includes('/api/public/safety-status')
  ? { ok: true, status: 200, json: async () => ({ data: { hasAlert: false, topTitle: null } }) }
  : { ok: false, status: 404, json: async () => ({}) })));

import TourDetailClient from '@/app/catalog/tours/[id]/_TourDetailClient';

const TOUR = {
  id: 120, title: 'Мыс Маячный и Халактырский пляж',
  description: 'Прогулка к маяку и по чёрному песку.',
  short_description: 'Выезд к мысу Маячному и на Халактырский пляж.',
  base_price: '9000', price_old: null, price_unit: 'person', activity_type: null as string | null, location_type: 'coast',
  location_name: 'Халактырский пляж', latitude: null, longitude: null, meeting_point: null, pickup_type: 'hotel_pickup',
  pickup_details: null, cancellation_policy: null, tour_image: null, photos: [], max_participants: null,
  min_participants: 1, duration_hours: '6', duration_type: 'single_day', multi_day_count: null, difficulty: 'easy',
  included: null, not_included: null, what_to_bring: null, season_start: null, season_end: null,
  seasonal_only: null, weather_dependent: null, rating: null, review_count: 0, operator_name: 'Тест',
  operator_id: 'p-120', operator_contacts: null,
};

afterEach(cleanup);

const crumbs = () => screen.getByRole('navigation', { name: 'Хлебные крошки' });

describe('крошка вида занятия у тура', () => {
  it('вида нет — в крошках только «Главная» и «Туры», без третьей ссылки и шеврона в конце', () => {
    const { container } = render(<TourDetailClient tour={TOUR} reviews={[]} />);
    const nav = crumbs();
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Главная', 'Туры']);
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/', '/catalog']);
    expect(nav.lastElementChild?.tagName).toBe('A');
    expect(nav.querySelectorAll('svg')).toHaveLength(1);
    const hrefs = [...container.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.filter((h) => h.includes('activity_type='))).toEqual([]);
    expect(container.innerHTML).not.toContain('activity_type=null');
  });

  it('вида нет — подписи вида над названием нет вместе с чертой', () => {
    render(<TourDetailClient tour={TOUR} reviews={[]} />);
    expect(screen.queryByTestId('tour-hero-activity')).toBeNull();
  });

  it('вид есть — третья крошка ведёт в каталог по виду, подпись над названием на месте', () => {
    render(<TourDetailClient tour={{ ...TOUR, activity_type: 'trekking' }} reviews={[]} />);
    const links = within(crumbs()).getAllByRole('link');
    expect(links).toHaveLength(3);
    expect(links[2].getAttribute('href')).toBe('/catalog?activity_type=trekking');
    expect(links[2].textContent).not.toBe('');
    expect(screen.getByTestId('tour-hero-activity').textContent).toBe(links[2].textContent);
  });

  it('значение вида в адресе закодировано', () => {
    render(<TourDetailClient tour={{ ...TOUR, activity_type: 'a b&c' }} reviews={[]} />);
    const links = within(crumbs()).getAllByRole('link');
    expect(links[2].getAttribute('href')).toBe('/catalog?activity_type=a%20b%26c');
  });
});
