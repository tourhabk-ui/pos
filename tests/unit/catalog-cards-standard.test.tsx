// @vitest-environment jsdom
/**
 * Карточки каталога мест и маршрутов «по стандартам индустрии» (22.11,
 * владелец: «я посмотрел страницы мест через мобильный и десктоп что то мы
 * перемудрили»).
 *
 * Маршрут — снимок одной пропорции, название, сложность и цифры пути
 * (км, набор, время) только записанные; пересказа описания на карточке нет.
 * Место — снимок, вид, название, сколько ехать, туры к месту; погоды зоны,
 * пеленга и сезона римскими цифрами нет. Судится рендером.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

vi.mock('@/hooks/use-wishlist', () => ({
  useWishlist: () => ({ on: false, busy: false, localOnly: false, toggle: () => {} }),
  wishlistLabel: () => 'В избранное',
  WISHLIST_LOCAL_ONLY_HINT: '',
}));
vi.mock('@/components/routes/useAnchor', () => ({
  useAnchor: () => ({ anchor: { lat: 53.0195, lng: 158.6505 }, label: 'от Петропавловска', requestGeo: () => {} }),
}));

import RoutePathCard, { routeCardFacts } from '@/components/routes/RoutePathCard';
import PlaceCard from '@/components/routes/PlaceCard';
import type { RouteItem } from '@/components/routes/RouteCard';

afterEach(() => cleanup());

const route = (over: Partial<RouteItem> = {}): RouteItem => ({
  id: '22222222-2222-4222-8222-222222222222', kind: 'route', urlSlug: 'vulkan-gorelyj',
  category: 'trekking', title: 'Вулкан Горелый', description: 'Длинный пересказ маршрута, которому место на странице.',
  lat: null, lng: null, difficulty: 'medium', durationDays: null, ...over,
});

const facts = (r: RouteItem) =>
  [...render(<RoutePathCard route={r} />).container.querySelectorAll('[data-testid="route-card-facts"] > span')]
    .map((n) => n.textContent?.replace(/\s/g, ' ').trim());

describe('карточка маршрута', () => {
  it('цифры пути — записанные, по порядку: сложность, км, набор, время', () => {
    expect(facts(route({ distanceKm: 9.5, elevationGainM: 1600, durationHours: 10 })))
      .toEqual(['Средний', '9,5 км', '1 600 м', '10 ч']);
  });

  it('не записано — не выдумывается: ни нулей, ни пустых значков', () => {
    expect(facts(route({ difficulty: null, distanceKm: null, elevationGainM: 0, durationHours: null }))).toEqual([]);
  });

  it('пересказа описания на карточке нет', () => {
    const { container } = render(<RoutePathCard route={route()} />);
    expect(container.textContent).not.toContain('Длинный пересказ');
    expect(container.querySelector('h2')?.textContent).toBe('Вулкан Горелый');
  });

  it('без фото — та же пропорция, что с фото: сетка не прыгает', () => {
    const a = render(<RoutePathCard route={route()} />).container.querySelector('a[data-testid="route-card-nophoto"]');
    cleanup();
    const b = render(<RoutePathCard route={route({ imageUrl: '/api/images/route/x' })} />).container.querySelector('a');
    const aspect = (cls: string | null | undefined) => cls?.split(' ').find((c) => c.startsWith('aspect-'));
    expect(a).not.toBeNull();
    expect(aspect(a?.getAttribute('class'))).toBe(aspect(b?.getAttribute('class')));
  });
});

describe('routeCardFacts', () => {
  it('время: сутки и больше — днями, меньше — часами; пометка дистанции', () => {
    const t = (r: Partial<RouteItem>) => routeCardFacts({ distanceKm: null, elevationGainM: null, durationHours: null, durationDays: null, ...r }).map((f) => f.text);
    expect(t({ durationDays: 3 })).toEqual(['3 дня']);
    expect(t({ durationHours: 48 })).toEqual(['2 дня']);
    expect(t({ durationHours: 4.5 })).toEqual(['4,5 ч']);
    expect(t({ durationDays: 1 })).toEqual(['1 день']);
    expect(t({ distanceKm: 12, distanceNote: 'в одну сторону' })).toEqual(['12 км в одну сторону']);
  });
});

describe('карточка места', () => {
  const place = (over: Partial<RouteItem> = {}): RouteItem => ({
    id: '33333333-3333-4333-8333-333333333333', kind: 'place', urlSlug: 'halaktyrskoe-ozero',
    category: 'lakes', locationType: 'lake', title: 'Халактырское озеро', description: '',
    lat: 53.03, lng: 158.75, difficulty: null, durationDays: null, ...over,
  });

  it('вид, название и сколько ехать — от Петропавловска', () => {
    const { container, getByText } = render(<PlaceCard route={place()} />);
    expect(getByText('Озеро')).toBeTruthy();
    expect(container.querySelector('h2')?.textContent).toBe('Халактырское озеро');
    expect(container.querySelector('[data-testid="place-card-distance"]')?.textContent).toMatch(/^\d+ км от Петропавловска$/);
  });

  it('нет координат — нет и расстояния', () => {
    const { container } = render(<PlaceCard route={place({ lat: null, lng: null })} />);
    expect(container.querySelector('[data-testid="place-card-distance"]')).toBeNull();
  });

  it('туры к месту — строкой со ссылкой на блок туров; нет туров — строки нет', () => {
    const withTours = render(<PlaceCard route={place({ placeTours: 3 })} />).container;
    const link = [...withTours.querySelectorAll('a')].find((a) => a.getAttribute('href')?.endsWith('#tours'));
    expect(link?.textContent).toMatch(/3 тура/);
    cleanup();
    const none = render(<PlaceCard route={place({ placeTours: 0 })} />).container;
    expect([...none.querySelectorAll('a')].some((a) => a.getAttribute('href')?.endsWith('#tours'))).toBe(false);
  });
});

// Владелец 22.11, снимок с телефона: «фото не адаптированы». Плитка места
// просила оригинал снимка, а не копию под карточку: тяжёлый файл на телефоне
// догружался сверху вниз, и низ рамки стоял белым.
describe('снимок плитки места — копия под карточку', () => {
  const place = (over: Partial<RouteItem> = {}): RouteItem => ({
    id: '33333333-3333-4333-8333-333333333333', kind: 'place', urlSlug: 'ozero-mikizha',
    category: 'lakes', locationType: 'lake', title: 'Озеро Микижа', description: '',
    lat: 53.2, lng: 158.4, difficulty: null, durationDays: null, ...over,
  });

  it('свой снимок — тем же адресом копии, что у плитки маршрута', async () => {
    const { ownCardPhotoUrl, cardImage } = await import('@/lib/routes/card-image');
    const p = place({ hasRealImage: true, imageUrl: '/somewhere/full.jpg' });
    const src = render(<PlaceCard route={p} />).container.querySelector('img')?.getAttribute('src');
    expect(src).toBe(ownCardPhotoUrl(p.id));
    expect(src).toBe(cardImage({ hasShownPhoto: true, id: p.id, kind: 'place' }).url);
    expect(src).toMatch(/\?size=card$/);
  });

  it('своего снимка нет — адрес из каталога как есть', () => {
    const src = render(<PlaceCard route={place({ hasRealImage: false, imageUrl: '/api/images/place-gallery/a/1' })} />)
      .container.querySelector('img')?.getAttribute('src');
    expect(src).toBe('/api/images/place-gallery/a/1');
  });

  it('пока снимок грузится, рамка залита, а не белая', () => {
    const frame = render(<PlaceCard route={place({ hasRealImage: true })} />).container.querySelector('img')?.parentElement;
    expect(frame?.getAttribute('class')).toContain('bg-[var(--bg-hover)]');
    expect(frame?.querySelector('img')?.getAttribute('decoding')).toBe('async');
  });
});
