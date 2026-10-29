/**
 * Подпись снимков на карточке тура (слово владельца 26.10 о кадрах гида:
 * «фото используй с подписью»).
 *
 * Подписи берутся из карты партнёра `partners.gallery_credits` (адрес →
 * автор), как у перевозчика и прокатчика. Сторож — рендер настоящей карточки
 * тура: под снимками строка «Фото: автор», в просмотрщике — подпись у кадра;
 * у кадра без записи подписи нет, и чужое имя ему не приписывается.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import React from 'react';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tourPhotoCaptions, tourPhotoCreditLine } from '@/lib/tours/photo-credits';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/catalog/tours/7',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/image', () => ({
  default: (p: { src: string; alt: string }) => React.createElement('img', { src: p.src, alt: p.alt }),
}));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/layout/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/marketplace/BookingFormClient', () => ({ default: () => null }));
vi.mock('@/components/marketplace/TourReviewForm', () => ({ default: () => null }));
vi.mock('@/components/marketplace/MessageOperatorButton', () => ({ default: () => null }));
vi.mock('@/components/safety/SafetyWarnings', () => ({ default: () => null }));
vi.mock('@/components/shared/KuzmichActions', () => ({ KuzmichActions: () => null }));

const { default: TourDetailClient } = await import('@/app/catalog/tours/[id]/_TourDetailClient');

const PHOTOS = [
  '/images/zaporozhets/gorely-crater-lake.jpg',
  '/images/zaporozhets/gorely-caldera.jpg',
  '/images/zaporozhets/gorely-blue-lake-snow.jpg',
];

function tour(credits: unknown): React.ComponentProps<typeof TourDetailClient>['tour'] {
  return {
    id: 7, title: 'Восхождение на вулкан Горелый', description: null, short_description: null,
    base_price: '12000', price_old: null, price_unit: 'per_person',
    activity_type: 'hiking', location_type: 'volcano', location_name: null,
    latitude: null, longitude: null, meeting_point: null, pickup_type: null, pickup_details: null,
    cancellation_policy: null, tour_image: null, photos: PHOTOS,
    max_participants: 10, min_participants: null, duration_hours: '11', duration_type: null,
    multi_day_count: null, difficulty: null, included: null, not_included: null, what_to_bring: null,
    season_start: null, season_end: null, seasonal_only: null, weather_dependent: null,
    rating: null, review_count: 0, operator_name: 'Андрей Запорожец', operator_id: 'p-1',
    operator_contacts: null, operator_photo_credits: credits,
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('подписи снимков тура — правило', () => {
  it('подпись только у кадра из карты и только непустой строкой', () => {
    expect(tourPhotoCaptions(PHOTOS, { [PHOTOS[0]]: 'Андрей Запорожец', [PHOTOS[1]]: '  ', '/чужой.jpg': 'Кто-то' }))
      .toEqual(['Фото: Андрей Запорожец', null, null]);
    expect(tourPhotoCaptions(PHOTOS, null)).toEqual([null, null, null]);
    expect(tourPhotoCaptions(PHOTOS, ['Андрей'])).toEqual([null, null, null]);
  });

  it('строка под снимками — авторы без повторов; без подписей строки нет', () => {
    expect(tourPhotoCreditLine(['Фото: А', null, 'Фото: Б', 'Фото: А'])).toBe('Фото: А, Б');
    expect(tourPhotoCreditLine([null, null])).toBeNull();
  });
});

describe('карточка тура показывает подпись', () => {
  it('под снимками — «Фото: автор», в просмотрщике — подпись у кадра', () => {
    const credits = Object.fromEntries(PHOTOS.map((u) => [u, 'Андрей Запорожец']));
    render(<TourDetailClient tour={tour(credits)} />);

    expect(screen.getByTestId('tour-photo-credit').textContent).toBe('Фото: Андрей Запорожец');

    fireEvent.click(screen.getByRole('button', { name: 'Открыть фото' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Фото: Андрей Запорожец')).toBeTruthy();
  });

  it('карта подписей пуста — строки нет и кадр в просмотрщике без подписи', () => {
    render(<TourDetailClient tour={tour({})} />);

    expect(screen.queryByTestId('tour-photo-credit')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Открыть фото' }));
    expect(within(screen.getByRole('dialog')).queryByText(/^Фото:/)).toBeNull();
  });
});

/**
 * Снимки гида Андрея Запорожца. Подпись «Фото: Андрей Запорожец» правдива,
 * только пока под ней ЕГО кадры: каждый адрес карты подписей 1338 — файл на
 * диске с нарезкой в манифесте вариантов и снимок хотя бы одного тура.
 *
 * 1341 (описания 29.10 с Диска) снимков не добавляет намеренно: все семь
 * картинок трёх docx — выгрузки с чужих сайтов (подписи kamchattour.ru,
 * tildacdn.com, «… туры и экскурсии на Камчатке», размер 664×442), и подпись
 * гида под ними была бы неправдой об авторстве. Запрет: адрес снимка в 1341
 * появится только вместе с его файлом и записью в карте подписей.
 */
describe('снимки гида — его кадры с подписью (1338, 1341)', () => {
  const ROOT = process.cwd();
  const m1338 = readFileSync(join(ROOT, 'migrations/1338_guide_zaporozhets_tours.sql'), 'utf-8');
  const m1341 = readFileSync(join(ROOT, 'migrations/1341_guide_answers_2026_10_29.sql'), 'utf-8');
  const manifest = new Set((JSON.parse(readFileSync(join(ROOT, 'lib/images/photo-variants.json'), 'utf-8')) as { src: string }[]).map((v) => v.src));
  const credited = [...new Set([...m1338.matchAll(/'(\/images\/zaporozhets\/[a-z0-9-]+\.jpg)', 'Андрей Запорожец'/g)].map((m) => m[1]))];
  const inTours = new Set([...m1338.matchAll(/ARRAY\[('\/images\/zaporozhets\/[^\]]+)\]::text\[\]/g)]
    .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])));

  it('каждый адрес карты подписей — файл, нарезка и снимок тура; снимков тура без подписи нет', () => {
    expect(credited).toHaveLength(24);
    for (const src of credited) {
      expect(existsSync(join(ROOT, 'public', src)), src).toBe(true);
      expect(manifest.has(src), src).toBe(true);
      expect(inTours.has(src), src).toBe(true);
    }
    for (const src of inTours) expect(credited, src).toContain(src);
  });

  it('1341 снимков не добавляет: туры по описаниям 29.10 идут без чужих картинок docx', () => {
    expect(m1341).not.toMatch(/\/images\//);
    expect(m1341).not.toMatch(/gallery_credits|tour_image|photos\s*=/);
  });
});
