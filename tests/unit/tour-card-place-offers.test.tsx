/**
 * Строка «к месту ещё N предложений — посмотреть» на САМОЙ карточке тура
 * (слово владельца 29.10, «3 да»; CLAUDE.md §11, п. 11а) — рендером карточки
 * и вызовом страницы, а не регуляркой по импорту (ревью 29.10: проп снимали
 * со страницы, вызов в карточке глушили — 861 тест оставался зелёным).
 *
 * Держит связку целиком:
 *   - страница передаёт карточке то, что вернул загрузчик по записанной связи;
 *   - карточка рисует ссылку на «Туры к этому месту» после блока оператора и
 *     до отзывов; «нет связи» и «не прочиталось» — строки нет.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/catalog/tours/62',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('notFound'); },
  permanentRedirect: () => { throw new Error('redirect'); },
}));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/layout/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/marketplace/BookingFormClient', () => ({ default: () => null }));
vi.mock('@/components/marketplace/TourReviewForm', () => ({ default: () => null }));
vi.mock('@/components/marketplace/MessageOperatorButton', () => ({ default: () => null }));
vi.mock('@/components/safety/SafetyWarnings', () => ({ default: () => null }));
vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));

import TourDetailClient from '@/app/catalog/tours/[id]/_TourDetailClient';
import type { PlaceOffersView } from '@/components/tours/PlaceOffersLine';

const TOUR = {
  id: 62, slug: null, title: 'Авачинский перевал', description: 'Джип-сафари к подножию вулканов.', short_description: null,
  base_price: '11000', price_old: null, price_unit: 'person', activity_type: 'jeep', location_type: 'volcano',
  location_name: 'Авачинский перевал', latitude: null, longitude: null, meeting_point: null, pickup_type: 'hotel_pickup',
  pickup_details: null, cancellation_policy: null, tour_image: null, photos: [], max_participants: 15,
  min_participants: null, duration_hours: '10', duration_type: 'day', multi_day_count: null, difficulty: 'medium',
  included: null, not_included: null, what_to_bring: null, season_start: null, season_end: null,
  seasonal_only: null, weather_dependent: null, rating: null, review_count: 0, operator_name: 'Оператор',
  operator_id: 'p-1', operator_contacts: null, main_place_id: 'p-ava',
};
const PLACE = { id: 'p-ava', name: 'Авачинский перевал', slug: 'avachinskiy-pereval', ark_id: null };

afterEach(() => { cleanup(); });

describe('карточка тура рисует строку «ещё N предложений»', () => {
  it('ссылка на туры места — после блока оператора и до отзывов', () => {
    const { container } = render(
      <TourDetailClient tour={TOUR as never} reviews={[]} placeOffers={{ state: 'ok', place: PLACE, others: 2 }} />,
    );
    const link = screen.getByRole('link', { name: 'посмотреть' });
    expect(link.getAttribute('href')).toBe('/places/avachinskiy-pereval#tours');
    expect(link.closest('p, div')?.textContent).toContain('К месту «Авачинский перевал» есть ещё 2 предложения');
    const reviews = container.querySelector('#reviews');
    expect(reviews).not.toBeNull();
    expect(link.compareDocumentPosition(reviews!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const operator = screen.getAllByText('Оператор').at(-1)!;
    expect(operator.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('связи нет или чтение не удалось — строки нет', () => {
    for (const offers of [{ state: 'none' }, { state: 'failed' }, null] as Array<PlaceOffersView | null>) {
      render(<TourDetailClient tour={TOUR as never} reviews={[]} placeOffers={offers} />);
      expect(screen.queryByRole('link', { name: 'посмотреть' })).toBeNull();
      cleanup();
    }
  });
});

describe('страница передаёт карточке то, что вернул загрузчик', () => {
  it('тур с главным местом — загрузчик спрошен по записанной связи, ответ ушёл в карточку', async () => {
    vi.resetModules();
    const offers: PlaceOffersView = { state: 'ok', place: PLACE, others: 3 };
    const loadPlaceOffersForTour = vi.fn(async () => offers);
    vi.doMock('@/lib/tours/tour-detail-query', () => ({
      loadTourCard: async () => ({ tour: TOUR, byId: false }),
      getTourReviews: async () => [],
    }));
    vi.doMock('@/lib/tours/open-dates', () => ({ countTourDates: async () => null, availabilityFromDates: () => undefined }));
    vi.doMock('@/lib/partners/reach', () => ({ reachForTour: async () => null }));
    vi.doMock('@/lib/places/place-tours', () => ({ loadPlaceOffersForTour }));
    vi.doMock('@/lib/seo/tour-structured-data', () => ({ buildTourStructuredData: () => ({}) }));
    vi.doMock('@/lib/zh/content', () => ({ zhTourAlternatePath: async () => null }));
    const Card = vi.fn(() => null);
    vi.doMock('@/app/catalog/tours/[id]/_TourDetailClient', () => ({ default: Card }));
    const { default: Page } = await import('@/app/catalog/tours/[id]/page');
    render(await Page({ params: Promise.resolve({ id: '62' }) }));
    expect(loadPlaceOffersForTour).toHaveBeenCalledWith({ id: 62, main_place_id: 'p-ava' });
    expect(Card).toHaveBeenCalled();
    expect((Card.mock.calls[0] as unknown as [{ placeOffers: unknown }])[0].placeOffers).toBe(offers);
  });
});
