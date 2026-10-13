/**
 * Ссылка из просьбы об отзыве ведёт к блоку отзывов карточки тура (разбор
 * 13.10, «как туристы оставляют отзывы?»).
 *
 * Сообщение после тура вело на `/catalog/tours/<id>#reviews`, а у блока
 * отзывов на карточке такого id не было: ссылка открывала карточку с начала,
 * и турист листал её всю в поисках формы. Сторож рендерит карточку и ищет
 * якорь из ссылки в документе — не строку в исходнике.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/catalog/tours/62',
  useSearchParams: () => new URLSearchParams(),
}));
// Тяжёлые соседи карточки — не предмет этого сторожа.
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/layout/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/marketplace/BookingFormClient', () => ({ default: () => null }));
vi.mock('@/components/marketplace/TourReviewForm', () => ({ default: () => <form aria-label="Оставить отзыв" /> }));
vi.mock('@/components/marketplace/MessageOperatorButton', () => ({ default: () => null }));
vi.mock('@/components/safety/SafetyWarnings', () => ({ default: () => null }));
vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));

import TourDetailClient from '@/app/catalog/tours/[id]/_TourDetailClient';
import { buildReviewRequestMessage } from '@/lib/notifications/guest-experience-copy';

const TOUR = {
  id: 62, title: 'Авачинский перевал', description: 'Джип-сафари к подножию вулканов.', short_description: null,
  base_price: '11000', price_old: null, price_unit: 'person', activity_type: 'jeep', location_type: 'volcano',
  location_name: 'Авачинский перевал', latitude: null, longitude: null, meeting_point: null, pickup_type: 'hotel_pickup',
  pickup_details: null, cancellation_policy: null, tour_image: null, photos: [], max_participants: 15,
  min_participants: null, duration_hours: '10', duration_type: 'day', multi_day_count: null, difficulty: 'medium',
  included: null, not_included: null, what_to_bring: null, season_start: null, season_end: null,
  seasonal_only: null, weather_dependent: null, rating: '5', review_count: 1, operator_name: 'Оператор',
  operator_id: 'p-1', operator_contacts: null,
};
const REVIEW = { id: 1, author_name: 'Анна П.', author_city: null, rating: 5, comment: 'Отличная поездка', trip_date: null };

describe('якорь отзывов на карточке тура', () => {
  it('ссылка из просьбы об отзыве попадает в блок «Отзывы»', () => {
    const msg = buildReviewRequestMessage({ touristName: 'Анна', tourTitle: TOUR.title, tourId: TOUR.id, appUrl: 'https://vedarai.ru' });
    const hash = msg.match(/href="[^"#]+#([^"]+)"/)?.[1];
    expect(hash).toBeTruthy();

    const { container } = render(<TourDetailClient tour={TOUR} reviews={[REVIEW]} />);
    const target = container.querySelector(`#${hash}`);
    expect(target, `на карточке нет элемента #${hash}`).not.toBeNull();
    expect(target?.textContent).toContain('Отзывы');
    expect(target?.textContent).toContain('Отличная поездка');
  });
});
