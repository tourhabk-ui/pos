/**
 * Сторож: /map говорит запасной Leaflet-карте, что лежит поверх её низа
 * (ревью 22.10, третий круг).
 *
 * Корень LeafletMap изолирует наложение: плашка «Своё положение не
 * определено» (z-index 1000) больше не всплывает над соседями страницы. На
 * офлайн-/map её закрыла полоса фильтров во всю ширину — GPS включён, синей
 * точки нет, а единственная фраза об этом под кнопками «Вулканы 5». На
 * онлайн-запасной карте рамка уходила под таб-бар телефона на 33 px, и там
 * же пряталась подпись OpenStreetMap.
 *
 * Держит рендером настоящего MapPageClient (карта подменена заглушкой,
 * которая запоминает пропы; раскладка задана элементам руками — jsdom её не
 * считает):
 *   — офлайн: bottomInset — высота полосы фильтров плюс зазор, подпись OSM в
 *     верхнем левом углу;
 *   — онлайн: bottomInset — высота счётчика «Точек: N», а низ рамки — над
 *     таб-баром (--bottom-nav-h).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import React from 'react';

const h = vi.hoisted(() => ({
  leaflet: null as Record<string, unknown> | null,
  ro: [] as Array<() => void>,
}));

vi.mock('next/dynamic', () => ({
  default: () => function DynamicStub(props: Record<string, unknown>) {
    // Запасная карта — та, что получает маркеры и приоритет геолокации.
    if ('markers' in props && 'locationPriority' in props) h.leaflet = props;
    return null;
  },
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement('a', { href, ...rest }, children),
}));
vi.mock('@/contexts/ThemeContext', () => ({ useTheme: () => ({ isDark: false, toggleTheme: () => {} }) }));
vi.mock('@/hooks/useMapQuakes', () => ({ MAP_QUAKE_HOURS: 24, useMapQuakes: () => ({ quakes: [], state: 'ok' }) }));
vi.mock('@/hooks/use-mesh', () => ({ useMesh: () => ({ peers: [] }) }));
vi.mock('@/hooks/useGeofence', () => ({ useGeofence: () => ({ breach: null, zonesAgeHours: null }) }));
vi.mock('@/hooks/usePlaceProximity', () => ({ usePlaceProximity: () => ({ nearbyPlace: null, dismiss: () => {} }) }));
vi.mock('@/lib/offline/db', () => ({ getAllOfflineRoutes: async () => [] }));
vi.mock('@/components/shared/BottomNav', () => ({ default: () => null }));
vi.mock('@/components/shared/EmergencyAction', () => ({ default: () => null }));
vi.mock('@/components/shared/AssistantButton', () => ({ AssistantButton: () => null }));
vi.mock('@/components/shared/Logo', () => ({ default: () => null }));
vi.mock('@/components/safety/GeofenceAlert', () => ({ GeofenceAlert: () => null }));
vi.mock('@/components/safety/SafetyReportPrompt', () => ({ SafetyReportPrompt: () => null }));

import MapPageClient from '@/app/map/_MapPageClient';

const PLACES = [
  { id: 'p1', title: 'Авачинский вулкан', locationType: 'volcano', activityType: null, lat: 53.25, lng: 158.83, description: 'x' },
  { id: 'p2', title: 'Курильское озеро', locationType: 'lake', activityType: null, lat: 51.45, lng: 157.1, description: 'x' },
];

class FakeResizeObserver {
  constructor(cb: () => void) { h.ro.push(cb); }
  observe() {}
  disconnect() {}
}

/** Раскладка, которую jsdom не считает: положение и размеры — руками. */
function place(el: HTMLElement, box: { top: number; height: number }, parentHeight: number) {
  Object.defineProperty(el, 'offsetTop', { configurable: true, value: box.top });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: box.height });
  const parent = el.parentElement as HTMLElement;
  Object.defineProperty(parent, 'clientHeight', { configurable: true, value: parentHeight });
}

let online = true;
const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');

beforeEach(() => {
  h.leaflet = null;
  h.ro = [];
  online = true;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
  // offsetTop считается от позиционированного родителя — в разметке /map это прямой родитель.
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true, get(this: HTMLElement) { return this.parentElement; },
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ success: true, data: PLACES }),
  } as Response)));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  if (offsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParent);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const remeasure = () => act(() => { for (const cb of h.ro) cb(); });

describe('офлайн-/map: плашка и углы — над полосой фильтров', () => {
  it('bottomInset — высота полосы фильтров с зазором; подпись OSM — в верхнем левом углу', async () => {
    online = false;
    render(<MapPageClient />);
    // Полоса фильтров: строка с кнопкой «Все» у нижнего края экрана.
    const all = await screen.findByRole('button', { name: /^Все/ });
    const bar = all.closest('div.absolute') as HTMLElement;
    expect(bar).toBeTruthy();
    place(bar, { top: 812 - 79, height: 79 }, 812);
    remeasure();
    await waitFor(() => expect(h.leaflet?.bottomInset).toBe(79 + 6));
    expect(h.leaflet?.attributionPosition).toBe('topleft');
  });
});

describe('онлайн-/map, запасная карта: низ рамки над таб-баром, плашка над счётчиком', () => {
  it('bottomInset — высота счётчика «Точек: N» с зазором', async () => {
    render(<MapPageClient />);
    const counter = (await screen.findByText(/Точек:/)).closest('div.absolute') as HTMLElement;
    expect(counter).toBeTruthy();
    place(counter, { top: 553 - 12 - 36, height: 36 }, 553);
    remeasure();
    await waitFor(() => expect(h.leaflet?.bottomInset).toBe(12 + 36 + 6));
  });

  it('высота рамки вычитает таб-бар телефона: иначе низ карты уходил под него', async () => {
    render(<MapPageClient />);
    await waitFor(() => expect(h.leaflet).not.toBeNull());
    expect(String(h.leaflet?.height)).toContain('var(--bottom-nav-h, 0px)');
  });
});
