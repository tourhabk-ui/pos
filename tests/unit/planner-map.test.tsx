/**
 * Сторож экрана: что карта планировщика говорит человеку (владелец 22.10:
 * «как работает карта в Планировщике не пойму?» → «карта да»).
 *
 * Рендером, на настоящем PlannerClient (карта Leaflet подменена заглушкой,
 * которая запоминает, ЧТО ей отдали рисовать) и на самой плашке карты:
 *   — отказ каталога — «Маршруты не загрузились…» и «Повторить», который
 *     спрашивает снова; не молчание и не «маршрутов нет»;
 *   — каталог ответил пусто — так и сказано;
 *   — легенда называет зоны словами, и кружок у зоны — того же цвета, что
 *     пины её точек, отданные карте;
 *   — дни плана уходят на карту кружками с номерами;
 *   — подсказка говорит, что делать с точкой; прежней плашки
 *     «N маршрутов по зонам» с четырьмя кружками-токенами нет.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import React from 'react';
import type { MapMarker } from '@/components/shared/leaflet-types';

const captured = vi.hoisted(() => ({ markers: [] as unknown[] }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/planner',
}));
vi.mock('next/dynamic', () => ({
  default: () => function LeafletStub(props: { markers?: unknown[] }) {
    captured.markers = props.markers ?? [];
    return null;
  },
}));
vi.mock('@/hooks/useMyReferralCode', () => ({ useMyReferralCode: () => null }));
vi.mock('@/lib/funnel/beacon', () => ({ funnelBeacon: vi.fn() }));

import { PlannerClient } from '@/app/planner/_PlannerClient';
import { PlannerMapOverlay, MAP_TEXT } from '@/components/planner/PlannerMapOverlay';
import { resolveMarkerColor } from '@/lib/map/marker-colors';
import { plannerLegend } from '@/lib/planner/map-markers';

/** Каталог: по маршруту в каждой из четырёх зон и один без зоны. */
const CATALOG = [
  { id: 'r1', title: 'Вулкан Авачинский', description: '', lat: 53.25, lng: 158.83, activityType: 'trekking', locationType: 'volcano', zone: 'avachinsky' },
  { id: 'r2', title: 'Курильское озеро', description: '', lat: 51.45, lng: 157.1, activityType: 'trekking', locationType: 'lake', zone: 'western' },
  { id: 'r3', title: 'Долина гейзеров', description: '', lat: 54.43, lng: 160.14, activityType: 'trekking', locationType: 'geyser', zone: 'eastern' },
  { id: 'r4', title: 'Вулкан Толбачик', description: '', lat: 55.83, lng: 160.33, activityType: 'trekking', locationType: 'volcano', zone: 'northern' },
  { id: 'r5', title: 'Маршрут без зоны', description: '', lat: 53.1, lng: 158.4, activityType: 'trekking', locationType: null, zone: null },
];

const day = (n: number, zone: string, title: string, coords: [number, number]) => ({
  day: n, type: 'activity', zone, title, description: '', activityType: 'volcano',
  priceFrom: 0, priceTo: 0, coords, defaultTransport: 'walking', allowedTransports: ['walking'],
  difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: [],
});

const RECOMMENDATION = {
  zones: [], warnings: [], itinerary: '',
  days: [
    day(1, 'avachinsky', 'Авачинский вулкан', [53.25, 158.83]),
    day(2, 'western', 'Курильское озеро', [51.45, 157.1]),
  ],
  priceBreakdown: { activities: [0, 0], accommodation: [0, 0], transport: [0, 0], perPersonTotal: [0, 0] },
};

type RoutesReply = 'data' | 'empty' | 'fail';
let routesReply: RoutesReply = 'data';
let routesCalls = 0;

beforeEach(() => {
  routesReply = 'data';
  routesCalls = 0;
  captured.markers = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.startsWith('/api/routes')) {
      routesCalls += 1;
      if (routesReply === 'fail') return { ok: false, status: 503, json: async () => ({ success: false }) } as Response;
      const data = routesReply === 'data' ? CATALOG : [];
      return { ok: true, status: 200, json: async () => ({ success: true, data }) } as Response;
    }
    const json = u.startsWith('/api/planner/recommend')
      ? { success: true, data: RECOMMENDATION }
      : { success: true, data: [], tours: [] };
    return { ok: true, status: 200, json: async () => json } as Response;
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** «#C2410C» → «rgb(194, 65, 12)» — так jsdom отдаёт цвет из style. */
function rgb(hex: string): string {
  const h = hex.replace('#', '');
  return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`;
}

const markers = () => captured.markers as MapMarker[];

describe('на настоящем экране планировщика', () => {
  it('отказ каталога — сказано словами, «Повторить» спрашивает снова', async () => {
    routesReply = 'fail';
    render(<PlannerClient />);
    const alert = await screen.findByText(MAP_TEXT.failed);
    expect(alert.closest('[role="alert"]')).toBeTruthy();
    expect(screen.queryByText(MAP_TEXT.empty)).toBeNull();
    const before = routesCalls;
    routesReply = 'data';
    fireEvent.click(screen.getByRole('button', { name: MAP_TEXT.retry }));
    await waitFor(() => expect(routesCalls).toBeGreaterThan(before));
    await screen.findByText(new RegExp(`${MAP_TEXT.legendTitle} · 5`));
    expect(screen.queryByText(MAP_TEXT.failed)).toBeNull();
  });

  it('каталог ответил пусто — «маршрутов нет», а не отказ и не молчание', async () => {
    routesReply = 'empty';
    render(<PlannerClient />);
    await screen.findByText(MAP_TEXT.empty);
    expect(screen.queryByText(MAP_TEXT.failed)).toBeNull();
  });

  it('легенда — зоны словами, кружок того же цвета, что пины этих точек на карте', async () => {
    render(<PlannerClient />);
    const list = await screen.findByRole('list', { name: 'Цвета зон на карте' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map(li => li.textContent)).toEqual([
      'Авачинская1', 'Западная1', 'Восточная1', 'Северная1', 'Зона не записана1',
    ]);
    const byZone = new Map(CATALOG.map(r => [r.id, r.zone]));
    const legend = plannerLegend(CATALOG.map(r => ({ id: r.id, title: r.title, lat: r.lat, lng: r.lng, zone: r.zone })));
    for (const [i, entry] of legend.entries()) {
      const swatch = items[i].querySelector('span[aria-hidden]') as HTMLElement;
      expect(swatch.style.background, entry.name).toBe(rgb(entry.hex));
      // Каждая точка этой зоны, отданная карте, рисуется тем же hex.
      const dots = markers().filter(m => byZone.has(m.id ?? '') && (byZone.get(m.id ?? '') ?? null) === entry.zone);
      expect(dots.length, entry.name).toBeGreaterThan(0);
      for (const m of dots) expect(resolveMarkerColor(m.color, 'blue'), m.id).toBe(entry.hex);
    }
  });

  it('подсказка говорит, что делать с точкой; прежней плашки с кружками-токенами нет', async () => {
    const { container } = render(<PlannerClient />);
    await screen.findByText(MAP_TEXT.hintNoPlan);
    expect(container.textContent).not.toMatch(/маршрутов по зонам/);
    expect(container.innerHTML).not.toMatch(/background: var\(--(accent|ocean|success|purple)\)/);
  });

  it('дни плана уходят на карту кружками с номерами, и легенда называет их', async () => {
    render(<PlannerClient />);
    fireEvent.change(screen.getByLabelText('Дата прилёта'), { target: { value: '2030-08-03' } });
    fireEvent.change(screen.getByLabelText('Дата отъезда'), { target: { value: '2030-08-12' } });
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: /Дальше/ }));
    fireEvent.click(screen.getByRole('button', { name: /Вулканы/ }));
    fireEvent.click(screen.getByRole('button', { name: /Собрать маршрут/ }));
    await screen.findByText(MAP_TEXT.hintPlan);
    expect(screen.getByText(MAP_TEXT.days)).toBeTruthy();
    const days = markers().filter(m => m.id?.startsWith('day_'));
    expect(days.map(m => m.label)).toEqual(['1', '2']);
    const dotColors = new Set(markers().filter(m => !m.id?.startsWith('day_') && !m.geometry).map(m => m.color));
    for (const d of days) expect(dotColors.has(d.color)).toBe(false);
  });
});

describe('плашка карты сама по себе', () => {
  const base = {
    legend: [], total: 0, partial: false, hasPlan: false, editing: null,
    onRetry: () => {}, onStopEditing: () => {},
  };

  it('загрузка — словами', () => {
    render(<PlannerMapOverlay {...base} status="loading" />);
    expect(screen.getByRole('status').textContent).toContain(MAP_TEXT.loading);
  });

  it('замена дня — что нажать и что значат яркие и серые', () => {
    const stop = vi.fn();
    render(<PlannerMapOverlay {...base} status="ok" total={3}
      legend={[{ zone: 'avachinsky', name: 'Авачинская', hex: '#C2410C', count: 3 }]}
      editing={{ number: 2, title: 'Курильское озеро' }} onStopEditing={stop} />);
    expect(screen.getByText('Замена дня 2: Курильское озеро')).toBeTruthy();
    expect(screen.getByText(MAP_TEXT.editAction)).toBeTruthy();
    expect(screen.getByText(MAP_TEXT.editColors)).toBeTruthy();
    // Легенда при замене не спорит с плашкой замены.
    expect(screen.queryByRole('list', { name: 'Цвета зон на карте' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Закончить замену дня' }));
    expect(stop).toHaveBeenCalled();
  });

  it('замена дня, а точек нет — плашка замены говорит почему, а не «нажмите точку»', () => {
    render(<PlannerMapOverlay {...base} status="empty" hasPlan editing={{ number: 1, title: 'Прилёт' }} />);
    expect(screen.getByText(MAP_TEXT.empty)).toBeTruthy();
    expect(screen.queryByText(MAP_TEXT.editAction)).toBeNull();
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('легенду можно свернуть — на телефоне она закрывает север края', () => {
    render(<PlannerMapOverlay {...base} status="ok" total={2}
      legend={[{ zone: 'northern', name: 'Северная', hex: '#15803D', count: 2 }]} />);
    const toggle = screen.getByRole('button', { name: /Маршруты по зонам · 2/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(MAP_TEXT.hintNoPlan)).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('list', { name: 'Цвета зон на карте' })).toBeNull();
    expect(screen.queryByText(MAP_TEXT.hintNoPlan)).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole('list', { name: 'Цвета зон на карте' })).toBeTruthy();
  });

  it('часть интересов не загрузилась — сказано под легендой', () => {
    render(<PlannerMapOverlay {...base} status="ok" total={1} partial
      legend={[{ zone: 'eastern', name: 'Восточная', hex: '#0891B2', count: 1 }]} />);
    expect(screen.getByText(MAP_TEXT.partial)).toBeTruthy();
  });
});
