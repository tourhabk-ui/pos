/**
 * Витрина «Туры сезона» на главной — только туры со снимком (29.10).
 *
 * Повод: 34 тура «Лагуны Экспедиции» пришли без фото и без сезона и встали
 * первыми — у остальных сезон кончился, а порядок «даты → по запросу → сезон
 * кончился» снимка не спрашивал. Первый экран главной стал рядом серых
 * заглушек. Правило одно для всех компаний: нет снимка — нет карточки на
 * главной, при любом сезоне; в каталоге тур остаётся. И правило называется
 * словами на самой витрине — на телефоне и на десктопе.
 *
 * Судится вызовом orderPlates на граничных данных и рендером обоих деревьев
 * главной. Что SQL выборки отсекает такие туры до LIMIT, держит
 * tests/integration/operators-list.pg.test.ts (fetchPlates на настоящей базе).
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/shared/BottomNav', () => ({ default: () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

import { orderPlates, HOME_TOURS_PHOTO_NOTE } from '@/lib/home/plate-facts';
import { DeskTours } from '@/components/homepage/desk/DeskTours';
import HomeV8Client from '@/app/_home/_HomeV8Client';
import type { HomeV8Data, Plate } from '@/app/_home/data';
import type { CatalogAvailability } from '@/lib/tours/catalog-availability';
import type { HomeWeather } from '@/lib/weather/home-widget-types';

const NO_WEATHER: HomeWeather = { kind: 'failed' };
const AVAILABILITIES: CatalogAvailability[] = ['dates', 'on_request', 'season_over'];

const plate = (id: string, availability: CatalogAvailability, imageUrl: string | null, operatorName = 'Оператор'): Plate => ({
  id, slug: `tour-${id}`, kind: 'tour', title: `Тур ${id}`, description: 'Описание', imageUrl,
  priceFrom: 10000, category: 'jeep_safari', locationType: null, volcanoStatus: null, priceUnit: 'per_person',
  operatorName, operatorSlug: null, operatorPublic: null, durationType: null, multiDayCount: null,
  durationHours: 8, cancellationPolicy: null, availability,
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('orderPlates: тур без снимка на главную не попадает', () => {
  it.each(AVAILABILITIES)('без снимка при «%s» — нет; со снимком при том же сезоне — есть', (a) => {
    const out = orderPlates([plate('bare', a, null), plate('blank', a, '   '), plate('shot', a, '/api/images/s3/photos/x/a.jpg')]);
    expect(out.map((p) => p.id)).toEqual(['shot']);
  });

  it('тур без снимка с датами не вытесняет тур со снимком, у которого сезон кончился', () => {
    // Ровно случай 29.10: открытые туры без фото стояли впереди закрытых с фото.
    const input = [
      ...Array.from({ length: 10 }, (_, i) => plate(`bare${i}`, 'dates', null, 'Лагуна Экспедиция')),
      plate('old', 'season_over', '/images/old.jpg', 'Другой оператор'),
    ];
    expect(orderPlates(input).map((p) => p.id)).toEqual(['old']);
  });

  it('одно правило для всех компаний: снимок решает, а не имя оператора', () => {
    const out = orderPlates([
      plate('a', 'on_request', '/images/a.jpg', 'А'), plate('b', 'on_request', null, 'Б'),
      plate('c', 'on_request', null, 'А'), plate('d', 'on_request', '/images/d.jpg', 'Б'),
    ]);
    expect(out.map((p) => p.id)).toEqual(['a', 'd']);
  });
});

describe('подпись витрины называет правило', () => {
  it('десктоп: под заголовком «Можно поехать» — строка о снимках и каталоге', () => {
    const { container } = render(<DeskTours plates={[plate('a', 'dates', '/images/a.jpg')]} total={40} rentalDoor={false} />);
    const section = container.querySelector('section[aria-labelledby="desk-tours-title"]');
    expect(section?.textContent).toContain(HOME_TOURS_PHOTO_NOTE);
    expect(HOME_TOURS_PHOTO_NOTE).toBe('На главной — туры со снимками; все туры — в каталоге.');
    // Каталог, куда подпись отсылает, — ссылка рядом.
    expect(section?.querySelector('a[href="/catalog"]')).not.toBeNull();
  });

  it('телефон: в блоке «Туры сезона» — та же строка, сразу под заголовком', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const data: HomeV8Data = {
      safety: { activeCount: 0, maxSeverity: 0, alerts: [], volcanoes: [], updatedAt: null },
      seismic: { events: [], source: 'none', updatedAt: null, checkedAt: null },
      radar: { hazards: [], center: { lat: 53.04, lng: 158.65, label: 'Петропавловск-Камчатский' } },
      zones: { open: 0, total: 0, updatedAt: null },
      plates: [plate('a', 'dates', '/images/a.jpg')], transfer: null, stay: null, explore: [], feed: [], stats: [], elements: [],
    };
    const { container } = render(<HomeV8Client data={data} weather={NO_WEATHER} />);
    const head = [...container.querySelectorAll('h2')].find((h) => h.textContent === 'Туры сезона');
    expect(head).toBeDefined();
    const section = head!.closest('section');
    const note = [...(section?.querySelectorAll('p') ?? [])].find((p) => p.textContent === HOME_TOURS_PHOTO_NOTE);
    expect(note).toBeDefined();
    // Подпись стоит до карточек, а не после ленты.
    const firstCard = section!.querySelector('figure.plate');
    expect(firstCard).not.toBeNull();
    expect(note!.compareDocumentPosition(firstCard!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
