/**
 * Фото и видео на десктопе не растягиваются шире своего размера — владелец
 * 14.10: «в дисктопе виде и фото расяниваються нужно сделать нормально».
 *
 * Замер 14.10 в браузере на 1920×1080, до правки:
 *   · герой страницы перевозчика: снимок 1156 px на всю ширину — в 1,66 раза;
 *   · герой карточки тура: снимки 900–1280 px, у операторов портретные
 *     960×1280, — вдвое;
 *   · просмотрщик фото: `fill` вписывал снимок 1156 px в экран — в 1,66 раза;
 *   · ролик перевозчика 640×356 — во всю колонку 717 px.
 *
 * Раскладку jsdom не считает, поэтому сторож держит то, что её задаёт, в
 * отрисованной разметке: резкий кадр героя — в рамке не шире колонки (72rem),
 * поля — тот же снимок размытый и только там, где он виден; снимок
 * просмотрщика не растянут на экран (не `fill`), а ограничен им; у плеера —
 * рамка 16:9 не шире 42rem. Размер в браузере — замер, записанный в коммите.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/catalog/tours/62',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/database', () => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/layout/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/marketplace/BookingFormClient', () => ({ default: () => null }));
vi.mock('@/components/marketplace/TourReviewForm', () => ({ default: () => null }));
vi.mock('@/components/marketplace/MessageOperatorButton', () => ({ default: () => null }));
vi.mock('@/components/safety/SafetyWarnings', () => ({ default: () => null }));
vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));

import { HeroPhoto } from '@/components/media/HeroPhoto';
import { CarrierHero } from '@/components/transfers/CarrierHero';
import { CarrierVideo } from '@/components/transfers/CarrierVideo';
import { CharterCard } from '@/components/transfers/CharterCard';
import { PhotoLightbox } from '@/components/shared/PhotoLightbox';
import TourDetailClient from '@/app/catalog/tours/[id]/_TourDetailClient';
import { photoSrc } from '@/lib/images/variant';
import type { CharterCarrier } from '@/lib/transfers/charter-format';

afterEach(() => cleanup());

/** Файл, который грузит картинка: в тестах next/image заворачивает его в /_next/image?url=. */
function fileOf(img: Element): string {
  const src = img.getAttribute('src') ?? '';
  return src.startsWith('/_next/image') ? new URL(src, 'http://x').searchParams.get('url') ?? '' : src;
}

/** Растянута ли картинка на родителя целиком — так рисует `fill`. */
const isFill = (img: Element) => /position:\s*absolute/.test(img.getAttribute('style') ?? '')
  && /width:\s*100%/.test(img.getAttribute('style') ?? '');

const SHATUN = '/images/shatun/shatun-01.jpg';

describe('герой: резкий кадр не шире колонки, поля — тот же снимок размытый', () => {
  it('HeroPhoto: рамка 72rem, резкий кадр — нарезка 1280, поля — 320 и только на широком экране', () => {
    const { container } = render(
      <div style={{ position: 'relative' }}><HeroPhoto src={SHATUN} alt="Шатун" objectPosition="50% 40%" /></div>,
    );
    const frame = container.querySelector('[data-hero-frame]') as HTMLElement;
    expect(frame.className).toMatch(/\bmax-w-6xl\b/);
    expect(frame.className).toMatch(/\bw-full\b/);
    const sharp = within(frame).getByAltText('Шатун');
    expect(fileOf(sharp)).toBe(photoSrc(SHATUN, 1280));
    expect((sharp as HTMLImageElement).style.objectPosition).toBe('50% 40%');
    // На широком экране снимок вписан в рамку, а не обрезан ею: узкий и
    // портретный кадр не растягивается и не теряет голову; на телефоне — обрезка, как было.
    expect(sharp.className.split(/\s+/)).toEqual(expect.arrayContaining(['object-cover', 'lg:object-contain']));

    const backdrop = container.querySelector('[data-hero-backdrop]') as HTMLImageElement;
    expect(backdrop.getAttribute('alt')).toBe('');
    expect(backdrop.getAttribute('aria-hidden')).toBe('true');
    expect(fileOf(backdrop)).toBe(photoSrc(SHATUN, 320));
    // На телефоне фона не видно — и снимок не качается; появляется там же, где вписывание.
    expect(backdrop.className.split(/\s+/)).toEqual(expect.arrayContaining(['hidden', 'lg:block', 'blur-2xl']));
    expect(backdrop.getAttribute('loading')).toBe('lazy');
  });

  it('страница перевозчика: герой через HeroPhoto, кадрирование 50% 40%; снимок открывается', () => {
    const { container } = render(
      <CarrierHero name="Шатун" photos={[{ url: SHATUN, credit: null }, { url: '/images/shatun/shatun-02.jpg', credit: null }]}>
        <h1>Шатун</h1>
      </CarrierHero>,
    );
    const frame = container.querySelector('[data-hero-frame]') as HTMLElement;
    expect(frame.className).toMatch(/\bmax-w-6xl\b/);
    const sharp = within(frame).getByAltText('Шатун');
    expect(fileOf(sharp)).toBe(photoSrc(SHATUN, 1280));
    expect((sharp as HTMLImageElement).style.objectPosition).toBe('50% 40%');
    fireEvent.click(screen.getByRole('button', { name: 'Открыть фото: Шатун' }));
    expect(screen.getByRole('dialog', { name: 'Шатун: фото 1 из 2' })).toBeTruthy();
  });

  it('карточка тура: герой через HeroPhoto, голову не режет (50% 30%), цвет — прежний', () => {
    const TOUR = {
      id: 62, title: 'Авачинский перевал', description: 'Джип-сафари к подножию вулканов.', short_description: null,
      base_price: '11000', price_old: null, price_unit: 'person', activity_type: 'jeep', location_type: 'volcano',
      location_name: 'Авачинский перевал', latitude: null, longitude: null, meeting_point: null, pickup_type: 'hotel_pickup',
      pickup_details: null, cancellation_policy: null, tour_image: SHATUN, photos: [], max_participants: 15,
      min_participants: null, duration_hours: '10', duration_type: 'day', multi_day_count: null, difficulty: 'medium',
      included: null, not_included: null, what_to_bring: null, season_start: null, season_end: null,
      seasonal_only: null, weather_dependent: null, rating: null, review_count: 0, operator_name: 'Оператор',
      operator_id: 'p-1', operator_contacts: null,
    };
    const { container } = render(<TourDetailClient tour={TOUR} reviews={[]} />);
    const frame = container.querySelector('header [data-hero-frame]') as HTMLElement;
    expect(frame, 'герой тура снова рисует снимок во всю ширину').not.toBeNull();
    expect(frame.className).toMatch(/\bmax-w-6xl\b/);
    const sharp = within(frame).getByAltText(TOUR.title) as HTMLImageElement;
    expect(fileOf(sharp)).toBe(photoSrc(SHATUN, 1280));
    expect(sharp.style.objectPosition).toBe('50% 30%');
    expect(sharp.style.filter).toContain('saturate(1.1)');
  });
});

describe('просмотрщик: снимок меньше экрана — как есть, больше — вписан', () => {
  it('не fill: размер файла, ограниченный экраном; оригинал, а не нарезка', () => {
    render(<PhotoLightbox images={[SHATUN]} alt="Шатун" startIdx={0} onClose={() => {}} />);
    const img = screen.getByAltText('Шатун — фото 1');
    expect(isFill(img), 'снимок снова растянут на экран целиком').toBe(false);
    expect(img.className.split(/\s+/)).toEqual(expect.arrayContaining(['w-auto', 'h-auto', 'max-w-full', 'max-h-full']));
    expect(fileOf(img)).toBe(SHATUN);
  });
});

describe('ролик перевозчика: рамка 16:9 не шире 42rem, без звука и предзагрузки', () => {
  const VIDEO = { url: '/video/shatun/shatun-bears.mp4', poster: '/video/shatun/shatun-bears.poster.jpg' };

  const checkPlayer = (root: HTMLElement) => {
    const videos = root.querySelectorAll('video[controls]');
    expect(videos).toHaveLength(1);
    const v = videos[0] as HTMLVideoElement;
    expect(v.className.split(/\s+/)).toEqual(expect.arrayContaining(['w-full', 'aspect-video', 'object-contain']));
    expect(v.closest('figure')?.className).toMatch(/\bmax-w-2xl\b/);
    expect(v.muted).toBe(true);
    expect(v.getAttribute('preload')).toBe('none');
    expect(v.getAttribute('poster')).toBe(VIDEO.poster);
    expect(v.hasAttribute('autoplay')).toBe(false);
    expect(v.querySelector('source')?.getAttribute('src')).toBe(VIDEO.url);
  };

  it('сам плеер', () => {
    const { container } = render(<CarrierVideo video={VIDEO} name="Шатун" />);
    checkPlayer(container);
    expect(container.textContent).toBe('Видео: Шатун');
  });

  it('карточка на витрине рисует тот же плеер', () => {
    const carrier = {
      partnerId: 'p-1', slug: 'shatun', name: 'Шатун', shortDescription: null, vehicles: [], destinations: [],
      extraDay: null, photos: [], clips: [], legal: null, video: VIDEO, phone: null, telegramHref: null, whatsappHref: null,
    } satisfies CharterCarrier;
    const { container } = render(<CharterCard carrier={carrier} />);
    checkPlayer(container);
  });
});
