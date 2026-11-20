/**
 * Туры на плитке места в каталоге (слово владельца 20.11: «на карточки мест
 * нужно добавить туры, если они есть»).
 *
 * Плитка называет только факт — сколько туров витрины идут к месту — и ведёт
 * к блоку «Туры к этому месту» на странице места (`#tours`). Цен и имён
 * компаний на плитке нет (§9: место — не тур). Туров нет или число не
 * прочиталось — строки нет, «туров нет» плитка не утверждает.
 *
 * Число считает каталог тем же отбором, что блок страницы места —
 * tests/integration/catalog-place-type.pg.test.ts. Здесь — рендер плитки.
 */
import React from 'react';
import { describe, it, expect, afterEach, vi, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@/hooks/use-wishlist', () => ({
  useWishlist: () => ({ on: false, busy: false, error: null, localOnly: false, toggle: async () => {} }),
  wishlistLabel: () => 'В избранное',
  WISHLIST_LOCAL_ONLY_HINT: '',
}));
vi.mock('@/components/routes/useAnchor', () => ({
  useAnchor: () => ({ anchor: { lat: 53.0195, lng: 158.6505 }, label: 'от Петропавловска', requestGeo: () => {} }),
}));

import PlaceCard from '@/components/routes/PlaceCard';
import type { RouteItem } from '@/components/routes/RouteCard';
import { placeToursLine, placeToursHref, toursWord } from '@/lib/places/place-tours-line';

beforeAll(() => {
  class IO { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { IntersectionObserver: typeof IO }).IntersectionObserver = IO;
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ zones: [] }), { status: 200 })) as typeof fetch;
});
afterEach(cleanup);

const place = (placeTours: number | null | undefined, extra: Partial<RouteItem> = {}): RouteItem => ({
  id: '4dd86a74-d010-4ff4-81ad-23af3ba966a5', kind: 'place', urlSlug: 'vulkan-gorelyy', category: 'vulkani',
  locationType: 'volcano', title: 'Вулкан Горелый', description: '', lat: 52.56, lng: 158.03,
  difficulty: null, durationDays: null, placeTours, ...extra,
});

describe('плитка места: туры к месту', () => {
  it('туры есть — строка «3 тура к месту» ведёт к блоку туров страницы места', () => {
    render(<PlaceCard route={place(3)} />);
    const link = screen.getByRole('link', { name: /3 тура к месту/ });
    const href = link.getAttribute('href') ?? '';
    expect(href.endsWith('#tours')).toBe(true);
    // Та же страница, куда ведёт название места.
    const title = screen.getByText('Вулкан Горелый').closest('a');
    expect(title?.getAttribute('href')).toBe('/places/vulkan-gorelyy');
    expect(href).toBe('/places/vulkan-gorelyy#tours');
  });

  it('цен и компаний на плитке нет', () => {
    const { container } = render(<PlaceCard route={place(5)} />);
    expect(container.textContent).not.toMatch(/₽|от \d/);
    expect(screen.getByText('5 туров к месту')).toBeTruthy();
  });

  it('готовый адрес вызывающего — тоже с якорем туров', () => {
    render(<PlaceCard route={place(1, { href: '/places/gorelyy' })} />);
    expect(screen.getByRole('link', { name: /1 тур к месту/ }).getAttribute('href')).toBe('/places/gorelyy#tours');
  });

  for (const n of [0, null, undefined]) {
    it(`туров ${String(n)} — строки нет, «туров нет» не утверждается`, () => {
      const { container } = render(<PlaceCard route={place(n)} />);
      expect(container.textContent).not.toMatch(/\d+\s+тур|к месту|туров нет/i);
      expect(container.querySelector('a[href$="#tours"]')).toBeNull();
    });
  }
});

describe('слова строки', () => {
  it('склонение «тур»', () => {
    const cases: Array<[number, string]> = [
      [1, 'тур'], [2, 'тура'], [4, 'тура'], [5, 'туров'], [11, 'туров'], [12, 'туров'], [14, 'туров'],
      [21, 'тур'], [22, 'тура'], [25, 'туров'], [101, 'тур'], [111, 'туров'], [112, 'туров'], [104, 'тура'],
    ];
    for (const [n, w] of cases) expect(toursWord(n), String(n)).toBe(w);
  });

  it('строки нет у нуля, отрицательного, дробного и не числа', () => {
    for (const n of [0, -1, 2.5, Number.NaN, null, undefined]) expect(placeToursLine(n as number | null | undefined)).toBeNull();
    expect(placeToursLine(2)).toBe('2 тура к месту');
  });

  it('якорь не удваивается', () => {
    expect(placeToursHref('/places/x#about')).toBe('/places/x#tours');
  });
});
