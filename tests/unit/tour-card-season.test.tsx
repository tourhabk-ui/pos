/**
 * Сезон на карточке тура — с днями и годом (08.11).
 *
 * До 08.11 карточка писала «Июл — Сен»: тур с прошедшим сезоном 2026 (три
 * тура «Камчатской рыбалки» на проде) выглядел так же, как тур сезона 2027.
 * Сторож судит рендером: что видит человек в полосе фактов и на чипе «О туре».
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, within } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/catalog/tours/79',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/layout/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/marketplace/TourReviewForm', () => ({ default: () => null }));
vi.mock('@/components/marketplace/MessageOperatorButton', () => ({ default: () => null }));
vi.mock('@/components/safety/SafetyWarnings', () => ({ default: () => null }));
vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));

import TourDetailClient from '@/app/catalog/tours/[id]/_TourDetailClient';

const TOUR = {
  id: 79, title: 'Курильское озеро на внедорожнике, 3 дня', description: 'Медведи и нерка.', short_description: null,
  base_price: '95000', price_old: null, price_unit: 'person', activity_type: 'jeep', location_type: 'lake',
  location_name: 'Курильское озеро', latitude: null, longitude: null, meeting_point: null, pickup_type: 'hotel_pickup',
  pickup_details: null, cancellation_policy: null, tour_image: null, photos: [], max_participants: 12,
  min_participants: 1, duration_hours: '72', duration_type: 'multi_day', multi_day_count: 3, difficulty: 'easy',
  included: null, not_included: null, what_to_bring: null, season_start: null, season_end: null,
  seasonal_only: null, weather_dependent: null, rating: null, review_count: 0, operator_name: 'Тест',
  operator_id: 'p-79', operator_contacts: null,
};

/** Значение полосы фактов под меткой «Сезон». */
function stripSeason(container: HTMLElement): string | null {
  const label = within(container).queryAllByText('Сезон').find((el) => el.nextElementSibling);
  return label?.nextElementSibling?.textContent ?? null;
}

describe('карточка тура: сезон', () => {
  it('сезон 2027 — днями и годом в полосе фактов и на чипе', () => {
    const { container } = render(
      <TourDetailClient tour={{ ...TOUR, season_start: '2027-07-19', season_end: '2027-09-29' }} reviews={[]} />,
    );
    expect(stripSeason(container)).toBe('19 июл — 29 сен 2027');
    expect(container.textContent).not.toMatch(/Июл — Сен/);
  });

  it('прошедший сезон называет свой год', () => {
    const { container } = render(
      <TourDetailClient tour={{ ...TOUR, season_start: new Date(2026, 5, 1), season_end: new Date(2026, 8, 15) }} reviews={[]} />,
    );
    expect(stripSeason(container)).toBe('1 июн — 15 сен 2026');
  });

  it('сезона нет — строки «Сезон» нет, ничего не выдумано', () => {
    const { container } = render(<TourDetailClient tour={TOUR} reviews={[]} />);
    expect(stripSeason(container)).toBeNull();
  });
});
