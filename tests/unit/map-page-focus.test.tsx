/**
 * Страница карты (`app/map/_MapPageClient.tsx`) по ссылке на место: карта
 * встаёт на место, его лист открыт, фильтр «на маршруте» его не прячет;
 * ссылка «обстановка» раскрывает панель угроз. Рендером: тяжёлые части
 * (своя карта, Leaflet, лист места, плашка) — заглушками, которые
 * показывают, что им передано.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import type { MapFocus } from '@/lib/map/map-target';

const seen = vi.hoisted(() => ({
  leaflet: [] as Array<{ center: [number, number]; zoom: number }>,
  sheets: [] as Array<{ id: string; title: string }>,
  chip: [] as boolean[],
}));

vi.mock('next/dynamic', () => ({
  default: (loader: () => Promise<unknown>) => {
    // Заглушки по тому, что грузит страница: Leaflet, лист места, плашки.
    const src = String(loader);
    if (src.includes('LeafletMap')) {
      return function LeafletStub(p: { center: [number, number]; zoom: number }) { seen.leaflet.push({ center: p.center, zoom: p.zoom }); return <div data-testid="leaflet" />; };
    }
    if (src.includes('PlaceMapSheet')) {
      return function SheetStub(p: { initialData: { id: string; title: string } }) { seen.sheets.push(p.initialData); return <div data-testid="sheet">{p.initialData.title}</div>; };
    }
    if (src.includes('MapThreatChip')) {
      return function ChipStub(p: { defaultOpen?: boolean }) { seen.chip.push(Boolean(p.defaultOpen)); return <div data-testid="chip" />; };
    }
    return function NoneStub() { return null; };
  },
}));
vi.mock('next/link', () => ({ default: (p: { href: string; children: React.ReactNode }) => <a href={p.href}>{p.children}</a> }));
vi.mock('@/contexts/ThemeContext', () => ({ useTheme: () => ({ isDark: false, toggleTheme: vi.fn() }) }));
vi.mock('@/components/shared/BottomNav', () => ({ default: () => null }));
vi.mock('@/components/shared/EmergencyAction', () => ({ default: () => null }));
vi.mock('@/components/shared/AssistantButton', () => ({ AssistantButton: () => null }));
vi.mock('@/components/shared/Logo', () => ({ default: () => null }));
vi.mock('@/hooks/use-mesh', () => ({ useMesh: () => ({ peers: [] }) }));
vi.mock('@/hooks/useGeofence', () => ({ useGeofence: () => ({ breach: null, zonesAgeHours: null }) }));
vi.mock('@/hooks/usePlaceProximity', () => ({ usePlaceProximity: () => ({ nearbyPlace: null, dismiss: vi.fn() }) }));
vi.mock('@/hooks/useMapQuakes', () => ({ useMapQuakes: () => ({ quakes: [], state: 'ready' }), MAP_QUAKE_HOURS: 24 }));
vi.mock('@/lib/offline/db', () => ({ getAllOfflineRoutes: async () => [] }));

import MapPageClient from '@/app/map/_MapPageClient';

const FOCUS: MapFocus = { state: 'place', place: { id: 'ark-1', title: 'Вулкан Мутновский', locationType: 'volcano', lat: 52.45, lng: 158.2 } };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); seen.leaflet.length = 0; seen.sheets.length = 0; seen.chip.length = 0; });

async function show(props: { focus?: MapFocus | null; openSafety?: boolean }) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, data: [] }))));
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true });
  render(<MapPageClient mapPackBaseUrl={null} {...props} />);
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe('карта по ссылке на место', () => {
  it('встаёт на место и открывает его лист', async () => {
    await show({ focus: FOCUS });
    const last = seen.leaflet.at(-1);
    expect(last?.center).toEqual([52.45, 158.2]);
    expect(last?.zoom).toBeGreaterThan(8);
    expect(screen.getByTestId('sheet').textContent).toBe('Вулкан Мутновский');
    expect(seen.sheets.at(-1)?.id).toBe('ark-1');
  });

  // Два места: одно на маршруте, второе — то, на которое ссылка, без маршрута.
  // Фильтр «на маршруте» оставил бы одну точку и спрятал место по ссылке.
  const ROUTES = [
    { id: 'p-on', title: 'На маршруте', locationType: 'lake', lat: 53.1, lng: 158.4, description: '', onRoute: true },
    { id: 'ark-1', title: 'Вулкан Мутновский', locationType: 'volcano', lat: 52.45, lng: 158.2, description: '', onRoute: false },
  ];
  const showWithRoutes = async (props: { focus?: MapFocus | null }) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, data: ROUTES }))));
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true });
    render(<MapPageClient mapPackBaseUrl={null} {...props} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };

  it('фильтр «на маршруте» место по ссылке не прячет: на карте обе точки', async () => {
    await showWithRoutes({ focus: FOCUS });
    expect(screen.getByText(/Точек:/).textContent).toBe('Точек: 2');
  });

  it('без ссылки фильтр «на маршруте» работает как раньше', async () => {
    await showWithRoutes({});
    expect(screen.getByText(/Точек:/).textContent).toBe('Точек: 1');
  });

  it('без ссылки — обзор края, листа нет', async () => {
    await show({});
    expect(seen.leaflet.at(-1)?.center).not.toEqual([52.45, 158.2]);
    expect(screen.queryByTestId('sheet')).toBeNull();
  });

  it('место не найдено — обзор края и строка об этом, листа нет', async () => {
    await show({ focus: { state: 'not_found' } });
    expect(seen.leaflet.at(-1)?.center).not.toEqual([52.45, 158.2]);
    expect(screen.queryByTestId('sheet')).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/Места по ссылке на карте нет/);
  });

  it('ссылка «обстановка» — панель угроз раскрыта', async () => {
    await show({ openSafety: true });
    expect(seen.chip.at(-1)).toBe(true);
  });
});
