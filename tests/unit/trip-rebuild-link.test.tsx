/**
 * «Собрать заново» со страницы сохранённой поездки несёт её даты, состав и
 * интересы (аудит планировщика 07.11, находка H17).
 *
 * Кнопка вела на пустой планер, и человек второй раз вводил то, что у него уже
 * записано. Сторож держит связку с обоих концов (§10.09): что страница кладёт
 * в адрес — и что планер из этого адреса отдаёт движку. Параметр, который
 * кладут, но не читают, — провод в никуда; его ловит ещё и
 * tests/unit/planner-link-params.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';

const nav = vi.hoisted(() => ({ query: '' }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(nav.query),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/planner',
}));
vi.mock('next/dynamic', () => ({ default: () => function DynamicStub() { return null; } }));
vi.mock('@/hooks/useMyReferralCode', () => ({ useMyReferralCode: () => null }));
vi.mock('@/lib/funnel/beacon', () => ({ funnelBeacon: vi.fn() }));
vi.mock('@/components/auth/Protected', () => ({
  Protected: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

import { plannerRebuildHref, type RebuildSource } from '@/lib/trips/rebuild-link';
import { TripDetailClient } from '@/app/hub/tourist/trips/[id]/_TripDetailClient';
import { PlannerClient } from '@/app/planner/_PlannerClient';

const FULL: RebuildSource = {
  arrival_date: '2030-08-01', departure_date: '2030-08-05',
  places: ['volcano', 'sea'], activities: ['trekking'],
  party: { adults: 3, children: [4, 9] },
};
const EMPTY: RebuildSource = { arrival_date: null, departure_date: null, places: [], activities: [], party: null };
const params = (href: string) => Object.fromEntries(new URL(href, 'https://vedarai.ru').searchParams.entries());

const DAY = { zone: 'avachinsky', activityType: 'volcano', coords: [53, 158], defaultTransport: 'walking', priceFrom: 0, priceTo: 0 };
const trip = (over: Record<string, unknown>) => ({
  id: 'trip-1', title: 'Маршрут', flight_arrival: null, flight_departure: null, transport_by_day: {},
  created_at: '2030-07-01T00:00:00Z', updated_at: '2030-07-02T03:00:00Z',
  days: [{ ...DAY, day: 1, type: 'arrival', title: 'Прилёт днём' }],
  needs_airport_transfer: false, needs_lodging: null, needs_car: null, warnings: null,
  ...over,
});

let tripReply: unknown = null;
let recommendBodies: Array<Record<string, unknown>> = [];
beforeEach(() => {
  nav.query = '';
  recommendBodies = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    const u = String(url);
    if (u.startsWith('/api/planner/recommend')) {
      recommendBodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
      return { ok: true, json: async () => ({ success: true, data: { zones: [], days: [], warnings: [], itinerary: '',
        priceBreakdown: { activities: [0, 0], accommodation: [0, 0], transport: [0, 0], perPersonTotal: [0, 0] } } }) } as Response;
    }
    const json = u.startsWith('/api/trips/') ? { success: true, data: tripReply } : { success: true, data: [], tours: [] };
    return { ok: true, json: async () => json } as Response;
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('адрес «Собрать заново»', () => {
  it('полная поездка: даты парой (дни включительно), интересы, состав', () => {
    const href = plannerRebuildHref(FULL);
    expect(new URL(href, 'https://vedarai.ru').pathname).toBe('/planner');
    expect(params(href)).toEqual({ from: '2030-08-01', days: '5', hint: 'volcano,sea,trekking', adults: '3', children: '4,9' });
  });

  it('даты: один день — days=1; отъезд раньше прилёта или одной даты нет — ни from, ни days', () => {
    expect(params(plannerRebuildHref({ ...EMPTY, arrival_date: '2030-08-01', departure_date: '2030-08-01' }))).toEqual({ from: '2030-08-01', days: '1' });
    for (const [arrival_date, departure_date] of [['2030-08-05', '2030-08-01'], ['2030-08-01', null], [null, '2030-08-05']] as const) {
      expect(plannerRebuildHref({ ...EMPTY, arrival_date, departure_date })).toBe('/planner');
    }
    // Дата, пришедшая моментом, — тот же календарный день.
    expect(params(plannerRebuildHref({ ...EMPTY, arrival_date: '2030-08-01T00:00:00.000Z', departure_date: '2030-08-02T00:00:00.000Z' })))
      .toEqual({ from: '2030-08-01', days: '2' });
  });

  it('состав: не записан — в адресе его нет; без детей — только взрослые', () => {
    expect(params(plannerRebuildHref({ ...FULL, party: null }))).not.toHaveProperty('adults');
    expect(params(plannerRebuildHref({ ...FULL, party: null }))).not.toHaveProperty('children');
    const noKids = params(plannerRebuildHref({ ...FULL, party: { adults: 1, children: [] } }));
    expect(noKids.adults).toBe('1');
    expect(noKids).not.toHaveProperty('children');
  });

  it('интересы: один id дважды — один раз; не id плитки в адрес не идёт', () => {
    expect(params(plannerRebuildHref({ ...EMPTY, places: ['volcano'], activities: ['volcano', 'fishing'] })).hint).toBe('volcano,fishing');
    expect(plannerRebuildHref({ ...EMPTY, places: ['Вулканы', 'a b', ''], activities: ['<script>'] })).toBe('/planner');
  });

  it('ничего не записано — ровно /planner, без знака вопроса', () => {
    expect(plannerRebuildHref(EMPTY)).toBe('/planner');
  });
});

describe('страница сохранённой поездки', () => {
  it('ссылка «Собрать заново» несёт даты, интересы и состав этой поездки', async () => {
    tripReply = trip({ ...FULL, party: { adults: 3, children: [4, 9], budgetTier: 'comfort', tripOrigin: 'visitor' } });
    render(<TripDetailClient tripId="trip-1" />);
    const link = await screen.findByRole('link', { name: /Собрать заново/ });
    expect(params(link.getAttribute('href')!)).toEqual({ from: '2030-08-01', days: '5', hint: 'volcano,sea,trekking', adults: '3', children: '4,9' });
  });

  it('старая поездка без дат, интересов и состава — обычный /planner', async () => {
    tripReply = trip(EMPTY);
    render(<TripDetailClient tripId="trip-1" />);
    expect((await screen.findByRole('link', { name: /Собрать заново/ })).getAttribute('href')).toBe('/planner');
  });
});

describe('планер читает то, что положила страница поездки', () => {
  const next = () => fireEvent.click(screen.getByRole('button', { name: /Дальше/ }));
  async function buildPlan(query: string): Promise<Record<string, unknown>> {
    nav.query = query;
    render(<PlannerClient />);
    next(); next(); next();
    fireEvent.click(screen.getByRole('button', { name: /Собрать маршрут/ }));
    await waitFor(() => expect(recommendBodies.length).toBeGreaterThan(0));
    return recommendBodies[0]!;
  }

  it('даты стоят в форме, а движок получает состав и интересы поездки', async () => {
    nav.query = plannerRebuildHref(FULL).split('?')[1]!;
    render(<PlannerClient />);
    expect((screen.getByLabelText('Дата прилёта') as HTMLInputElement).value).toBe('2030-08-01');
    expect((screen.getByLabelText('Дата отъезда') as HTMLInputElement).value).toBe('2030-08-05');
    next(); next(); next();
    fireEvent.click(screen.getByRole('button', { name: /Собрать маршрут/ }));
    await waitFor(() => expect(recommendBodies.length).toBeGreaterThan(0));
    const body = recommendBodies[0]!;
    expect(body).toMatchObject({ arrivalDate: '2030-08-01', departureDate: '2030-08-05', adults: 3, children: [4, 9] });
    expect([...(body.interests as string[])].sort()).toEqual(['sea', 'trekking', 'volcano']);
  });

  it('прежняя ссылка с карточки тура — один ключ в hint — работает как раньше', async () => {
    const body = await buildPlan('hint=fishing&from=2030-08-01&days=5');
    expect(body.interests).toEqual(['fishing']);
    expect(body).toMatchObject({ adults: 2, children: [] });
  });

  it('битый состав в адресе не принимается: двое взрослых и без детей, как без ссылки', async () => {
    const body = await buildPlan('adults=0&children=40&hint=volcano&from=2030-08-01&days=5');
    expect(body).toMatchObject({ adults: 2, children: [] });
    cleanup();
    recommendBodies = [];
    // Частично годный список детей не принимается кусками.
    expect(await buildPlan('adults=9&children=4,40&hint=volcano&from=2030-08-01&days=5')).toMatchObject({ adults: 2, children: [] });
  });
});
