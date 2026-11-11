/**
 * Плашка «Обстановка в крае» не наезжает на название тура (11.11).
 *
 * Гид Андрей Запорожец прислал снимок «Восхождение на Авачинский вулкан»:
 * «в таком размере кнопка обстановка не даёт прочитать название тура».
 * Причина — устройство героя: высота фиксирована (min(64vh, 560px)), плашка
 * стоит абсолютом сверху, а текст — абсолютом снизу. Длинное название и
 * описание растут вверх и уходят под плашку, а крошки обрезает край героя.
 *
 * Раскладку jsdom не считает, поэтому сторож держит само устройство, без
 * которого наезд невозможен: у героя нет фиксированной высоты, плашка и
 * текст — в потоке колонки (не absolute), плашка — до текста.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

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
  id: 120, title: 'Восхождение на Авачинский вулкан',
  description: 'Подъём по шлаковым склонам к кратеру.',
  short_description: 'Авторский тур гида: внедорожник по Сухой речке, подъём 4–6 часов по шлаковым склонам к кратеру Авачинского вулкана (2741 м) с лавовой пробкой и фумаролами. По четыре человека в машине.',
  base_price: '18000', price_old: null, price_unit: 'person', activity_type: 'trekking', location_type: 'volcano',
  location_name: 'Авачинский вулкан', latitude: null, longitude: null, meeting_point: null, pickup_type: 'hotel_pickup',
  pickup_details: null, cancellation_policy: null, tour_image: null, photos: [], max_participants: null,
  min_participants: 1, duration_hours: '12', duration_type: 'single_day', multi_day_count: null, difficulty: 'hard',
  included: null, not_included: null, what_to_bring: null, season_start: null, season_end: null,
  seasonal_only: null, weather_dependent: null, rating: null, review_count: 0, operator_name: 'Тест',
  operator_id: 'p-120', operator_contacts: null,
};

describe('герой тура: плашка дня и название не накладываются', () => {
  it('у героя нет фиксированной высоты — длинный текст растит его', () => {
    render(<TourDetailClient tour={TOUR} reviews={[]} />);
    const hero = screen.getByTestId('tour-hero');
    expect(hero.style.height).toBe('');
    expect(hero.style.minHeight).not.toBe('');
  });

  it('плашка и текст — в потоке колонки, плашка выше текста', async () => {
    render(<TourDetailClient tour={TOUR} reviews={[]} />);
    const status = await waitFor(() => screen.getByTestId('tour-hero-status'));
    const text = screen.getByTestId('tour-hero-text');
    expect(status.textContent).toContain('Обстановка в крае');
    expect(status.className).not.toMatch(/\babsolute\b/);
    expect(text.className).not.toMatch(/\babsolute\b/);
    expect(status.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Название и описание — внутри текстового блока, а не поверх плашки.
    expect(text.querySelector('h1')?.textContent).toBe(TOUR.title);
  });
});
