/**
 * Снимок первого экрана грузится сразу, остальные — лениво (SEO-аудит 27.11,
 * карт-бланш владельца).
 *
 * Аудит назвал 55 страниц, где первая картинка грузилась с задержкой. Настоящая
 * задержка была там, где ленивый снимок стоит в первом экране: первая карточка
 * /car-rental, /transfers, /accommodations, герой карточки жилья и баннер
 * /planning. Остальные карточки списка остаются ленивыми: иначе React ставит
 * предзагрузку на каждую (разбор 23.11, components/media/PlatePhoto.tsx).
 *
 * Судится рендером: у первой карточки снимок без loading="lazy" (next/image
 * с priority, высокий приоритет — предзагрузкой), у второй — ленивый.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/shared/BottomNav', () => ({ default: () => null }));

import { CarRentalPage } from '@/components/rental/CarRentalPage';
import { TransfersPage } from '@/components/transfers/TransfersPage';
import { AccommodationCard } from '@/components/shared/AccommodationCard';
import type { RentalCompany } from '@/lib/rental/rental-format';
import type { CharterState } from '@/lib/transfers/charter-format';

const company = (id: string, name: string): RentalCompany => ({
  partnerId: id, slug: id, name, shortDescription: null, logo: null,
  photos: [{ url: `/api/images/s3/photos/${id}/car.jpg`, credit: null }],
  phone: null, telegramHref: null, offers: [],
} as unknown as RentalCompany);

const carrier = (id: string, name: string) => ({
  partnerId: id, slug: id, name, shortDescription: null, logo: null,
  vehicles: [], seatClasses: [], destinations: [], extraDay: null, rates: [],
  photos: [{ url: `/api/images/s3/photos/${id}/bus.jpg`, credit: null }],
  clips: [], legal: null, video: null, phone: null,
});

/** Снимки карточек по их подписи «<имя>: фото машины», в порядке страницы. */
const cardImgs = (c: HTMLElement) => [...c.querySelectorAll('img')].filter((i) => /фото машины/.test(i.alt));
// next/image с `priority` снимает loading="lazy", а высокий приоритет отдаёт
// предзагрузкой (ReactDOM.preload), не атрибутом самой картинки.
const eager = (img: HTMLImageElement) => img.getAttribute('loading') !== 'lazy';
const lazy = (img: HTMLImageElement) => img.getAttribute('loading') === 'lazy';

describe('первая карточка списка — сразу, остальные — лениво', () => {
  it('/car-rental', () => {
    const { container } = render(
      <CarRentalPage rental={{ state: 'ok', companies: [company('a', 'Первый'), company('b', 'Второй')] }} />,
    );
    const imgs = cardImgs(container);
    expect(imgs).toHaveLength(2);
    expect(eager(imgs[0]!)).toBe(true);
    expect(lazy(imgs[1]!)).toBe(true);
  });

  it('/transfers', () => {
    const charter = { state: 'ok', carriers: [carrier('a', 'Первый'), carrier('b', 'Второй')] } as unknown as CharterState;
    const { container } = render(<TransfersPage charter={charter} />);
    const imgs = cardImgs(container);
    expect(imgs).toHaveLength(2);
    expect(eager(imgs[0]!)).toBe(true);
    expect(lazy(imgs[1]!)).toBe(true);
  });

  it('карточка жилья: с priority — сразу, без — лениво', () => {
    const props = {
      id: 'h1', name: 'Кутха', type: 'guesthouse', description: '', address: null,
      pricePerNight: { from: 3000, currency: 'RUB' }, rating: null, reviewCount: 0, amenities: [],
      images: [{ url: '/api/images/s3/photos/h1/house.jpg', alt: 'Дом снаружи' }],
    };
    const first = render(<AccommodationCard {...props} priority />).container.querySelector('img[alt="Дом снаружи"]') as HTMLImageElement;
    expect(eager(first)).toBe(true);
    const rest = render(<AccommodationCard {...props} />).container.querySelector('img[alt="Дом снаружи"]') as HTMLImageElement;
    expect(lazy(rest)).toBe(true);
  });
});
