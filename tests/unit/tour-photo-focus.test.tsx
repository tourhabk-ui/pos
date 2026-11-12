// @vitest-environment jsdom
/**
 * Точка кадра — у снимка, а не одна на все фото (владелец 12.11: «и на
 * десктопной тоже небо вместо локаций»).
 *
 * Плитка каталога 16:10 показывает портрет 3:4 лишь на 47% высоты. Верх кадра
 * (`50% 0%`) держит голову рыбака (30.09), но у вертикально снятого пейзажа
 * там небо: «Мыс Маячный» и «Часовая прогулка на вездеходе» в каталоге были
 * голубыми прямоугольниками. Сторож держит обе стороны: записанный снимок
 * встаёт на свою точку во всех своих адресах, незаписанный — на верх кадра.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  PHOTO_FOCUS_Y, TOUR_PHOTO_POSITION, photoFocusKey, photoFocusY, tourPhotoPosition,
} from '@/lib/tours/photo-focus';

vi.mock('next/image', () => ({
  default: (p: { src: string; alt: string; style?: React.CSSProperties }) =>
    React.createElement('img', { src: p.src, alt: p.alt, style: p.style }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/catalog',
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/lib/auth/session-state', () => ({ sessionState: () => Promise.resolve(false) }));

import MarketplaceClient from '@/components/marketplace/MarketplaceClient';

afterEach(() => { cleanup(); });

const MYS = '/api/images/s3/photos/laguna-expedition/mys-mayachnyj-cover.jpg';
const SEVER = '/api/images/s3/photos/laguna-expedition/chasovaya-progulka-cover.jpg';
const FISHER = '/api/images/s3/photos/fishingkam/catch-01.jpg';

describe('точка кадра снимка', () => {
  it('один снимок узнаётся во всех своих адресах', () => {
    for (const src of [
      MYS,
      'https://vedarai.ru/api/images/s3/photos/laguna-expedition/mys-mayachnyj-cover.jpg?v=2',
      '/api/images/s3/photos/laguna-expedition/mys-mayachnyj-cover.640.webp',
      '/images/laguna-expedition/mys-mayachnyj-cover.jpg',
      '  ' + MYS + '  ',
    ]) {
      expect(photoFocusKey(src), src).toBe('laguna-expedition/mys-mayachnyj-cover');
    }
  });

  it('обе обложки из жалобы встают на предмет съёмки, а не на небо', () => {
    expect(tourPhotoPosition(MYS)).toBe('50% 70%');
    expect(tourPhotoPosition(SEVER)).toBe('50% 65%');
  });

  it('незаписанный снимок, пустота и мусор — верх кадра (голова рыбака цела)', () => {
    expect(TOUR_PHOTO_POSITION).toBe('50% 0%');
    for (const src of [FISHER, null, undefined, '', '   ', '/api/images/s3/photos/', 'https://x.ru/']) {
      expect(tourPhotoPosition(src), String(src)).toBe(TOUR_PHOTO_POSITION);
      expect(photoFocusY(src), String(src)).toBeNull();
    }
    // Ключ из прототипа объекта — не запись.
    expect(photoFocusY('/api/images/s3/photos/constructor.jpg')).toBeNull();
  });
});

/** Ширина и высота JPEG по маркеру SOF — без зависимостей. */
function jpegSize(buf: Buffer): { w: number; h: number } | null {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

describe('записи точки — только у проверенных портретных снимков', () => {
  const entries = Object.entries(PHOTO_FOCUS_Y);
  it('список не пуст', () => expect(entries.length).toBeGreaterThan(0));
  for (const [key, y] of entries) {
    it(key, () => {
      expect(Number.isInteger(y) && y >= 0 && y <= 100, `${key}: точка ${y} вне 0..100`).toBe(true);
      const file = join(process.cwd(), 'media/s3/photos', `${key}.jpg`);
      expect(existsSync(file), `${key}: снимка нет в media/s3/photos — точка висит на несуществующем кадре`).toBe(true);
      const size = jpegSize(readFileSync(file));
      expect(size, `${key}: не прочитал размер`).not.toBeNull();
      // Пейзажу шире плитки вертикальная точка не нужна: запись была бы мёртвой.
      expect(size!.h, `${key}: снимок не портретный`).toBeGreaterThan(size!.w);
    });
  }
});

type Tour = NonNullable<React.ComponentProps<typeof MarketplaceClient>['initialTours']>[number];
const tour = (over: Partial<Tour>): Tour => ({
  id: 1, slug: 'a', title: 'Тур', description: null, short_description: null,
  base_price: 25000, price_old: null, price_unit: 'per_person', activity_type: 'jeep_safari', location_type: 'volcano',
  location_name: 'Халактырский пляж', tour_image: null, operator_name: 'Лагуна Экспедиция', operator_id: 'p1',
  operator_verified: true, operator_slug: 'laguna-expedition', operator_public: true, bookings_count: 0,
  duration_hours: 3, duration_type: 'single_day', multi_day_count: null, difficulty: 'easy', included: null,
  season_start: null, season_end: null, has_availability: false,
  ...over,
});
const KEY = JSON.stringify({ search: '', activityFilter: '', sort: 'recommended', difficulty: '', priceRange: '', durationType: '' });

describe('карточка каталога рисует снимок с его точкой', () => {
  it('Мыс Маячный — на бухте, рыбак — на верхе кадра', () => {
    const tours = [
      tour({ id: 90, slug: 'mys', title: 'За снегоходом на Мыс Маячный', tour_image: MYS }),
      tour({ id: 7, slug: 'fish', title: 'Семейный тур выходного дня', tour_image: FISHER, activity_type: 'fishing' }),
    ];
    const { container } = render(
      <MarketplaceClient initialTours={tours} initialTotal={tours.length} initialKey={KEY} summary={null} />,
    );
    const byAlt = (alt: string) => container.querySelector<HTMLImageElement>(`img[alt="${alt}"]`);
    expect(byAlt('За снегоходом на Мыс Маячный')?.style.objectPosition).toBe('50% 70%');
    expect(byAlt('Семейный тур выходного дня')?.style.objectPosition).toBe('50% 0%');
  });
});
