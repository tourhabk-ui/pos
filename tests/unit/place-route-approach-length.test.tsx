/**
 * Длина линии с влитым подъездом — не длина маршрута (#3487, п.17).
 *
 * Маршрут «Ксудач и Ходутка» стоит на карточке Ксудача с длиной 242,5 км:
 * в линию влита дорога, дальний конец в сотне километров от записи. Судья
 * принадлежности (lib/routes/line-ownership) называет такую линию
 * own_with_approach — линия своя, врёт число. Карточка места и Кузьмич
 * называют это число «вместе с подъездом», а не «длина маршрута».
 *
 * Судится вызовом правила и рендером списка маршрутов места.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));

import { lineWithApproach, placeRoutesLines, toPlaceRouteRow, type PlaceRouteRow } from '@/lib/places/place-routes';
import PlaceRoutes from '@/components/places/PlaceRoutes';

/** Точка записи у Ксудача; линия начинается рядом и уходит на ~110 км к северу. */
const POINT = { route_lat: 51.8, route_lng: 157.53 };
const APPROACH_LINE = [[157.53, 51.8], [157.6, 52.3], [157.7, 52.8]];
/** Своя линия без подъезда: оба конца в паре километров от записи. */
const OWN_LINE = [[157.53, 51.8], [157.54, 51.81], [157.55, 51.805]];

const base: PlaceRouteRow = {
  id: 'r-1', slug: 'ksudach-i-khodutka', title: 'Ксудач и Ходутка',
  activity_type: 'trek', difficulty: 'hard', distance_km: 242.5, duration_hours: null, link_kind: 'waypoint',
} as PlaceRouteRow;

describe('длина линии с подъездом (#3487, п.17)', () => {
  it('судья: подъезд — да; своя линия, нет точки или нет линии — нет', () => {
    expect(lineWithApproach({ ...POINT, line_coords: APPROACH_LINE })).toBe(true);
    expect(lineWithApproach({ ...POINT, line_coords: OWN_LINE })).toBe(false);
    expect(lineWithApproach({ route_lat: null, route_lng: null, line_coords: APPROACH_LINE })).toBe(false);
    expect(lineWithApproach({ ...POINT, line_coords: null })).toBe(false);
  });

  it('строка: число уходит из длины маршрута в своё поле; сырые поля линии наружу не идут', () => {
    const row = toPlaceRouteRow({ ...base, ...POINT, line_coords: APPROACH_LINE });
    expect(row.distance_km).toBeNull();
    expect(row.distance_with_approach_km).toBe(242.5);
    expect(Object.keys(row)).not.toContain('line_coords');
    expect(Object.keys(row)).not.toContain('route_lat');

    const own = toPlaceRouteRow({ ...base, distance_km: 12, ...POINT, line_coords: OWN_LINE });
    expect(own.distance_km).toBe(12);
    expect(own.distance_with_approach_km).toBeNull();
  });

  it('Кузьмич: «вместе с подъездом — это не длина тропы», а не «длина маршрута»', () => {
    const row = toPlaceRouteRow({ ...base, ...POINT, line_coords: APPROACH_LINE });
    const text = placeRoutesLines([row]).join('\n');
    expect(text).toContain('длина линии 242.5 км вместе с подъездом — это не длина тропы');
    expect(text).not.toContain('длина маршрута 242.5');
  });

  it('карточка места: «км вместе с подъездом — не длина тропы», «длина 242.5 км» не пишется', () => {
    render(
      <PlaceRoutes
        placeId="p-1"
        routes={[{
          id: 'r-1', slug: 'ksudach-i-khodutka', title: 'Ксудач и Ходутка', activityType: 'trek', difficulty: 'hard',
          distanceKm: null, distanceWithApproachKm: 242.5, durationHours: null, linkKind: 'waypoint',
        }]}
      />,
    );
    const item = screen.getByText('Ксудач и Ходутка').closest('a') as HTMLElement;
    expect(item.textContent).toContain('242.5 км вместе с подъездом — не длина тропы');
    expect(item.textContent).not.toContain('длина 242.5');
  });
});
