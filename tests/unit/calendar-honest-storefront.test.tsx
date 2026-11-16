/**
 * Календарь туров /calendar — общая витрина по правилам §0 и §4.0 (16.11).
 *
 * Сравнение с календарём конкурента 16.11 (снимки владельца) показало на
 * проде: туры дня стоят по цене от дешёвых к дорогим без подписи; у
 * оператора «★ 0.0» без единого отзыва; служебные слова «jeep_safari» и
 * «horseback» вместо названий видов; кнопка «Джип-тур» искала `jeep`, а туры
 * записаны `jeep_safari`; «375 слотов» — сумма туров по дням под чужим словом.
 *
 * Здесь — поведение: адреса вызовом с подменённой базой, страница рендером.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/booking/TourPaymentModal', () => ({ default: () => null }));

import { GET as monthRoute } from '@/app/api/availability/route';
import { GET as dayRoute } from '@/app/api/availability/day/route';
import CalendarClient from '@/app/calendar/_CalendarClient';
import { OFFER_ORDER_NOTE_DAY_RU, offerOrderDay, tourLot } from '@/lib/tours/offer-order';

function row(over: Record<string, unknown>) {
  return {
    tour_id: '1', title: 'Тур', description: null, activity_type: 'trekking', location_name: null,
    base_price: '10000', price_override: null, price_unit: 'per_person', duration_hours: '3', duration_type: null,
    max_participants: 10, min_participants: 1, group_size_unlimited: false, available_slots: 10, booked_slots: 0,
    free_slots: 10, weather_status: 'ok', operator_id: 'p1', operator_name: 'Компания', operator_verified: true,
    operator_slug: null, operator_public: null, operator_rating: null, operator_review_count: 0, tags: [],
    ...over,
  };
}

const req = (url: string) => new NextRequest(url);

beforeEach(() => {
  queryMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('/api/availability/day — туры дня', () => {
  it('порядок — правило 1в (жребий дня), а не цена', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T03:00:00Z'));
    const day = offerOrderDay();
    const ids = ['11', '12', '13', '14', '15', '16'];
    const byLot = [...ids].sort((a, b) => tourLot(day, a) - tourLot(day, b));
    // Предпосылка: жребий не совпадает ни с порядком id, ни с порядком цены.
    expect(byLot).not.toEqual(ids);
    queryMock.mockResolvedValueOnce({
      rows: ids.map((id, i) => row({ tour_id: id, base_price: String(3500 + i * 10000) })),
    });
    const res = await dayRoute(req('http://localhost/api/availability/day?date=2099-07-19'));
    const body = await res.json() as { tours: Array<{ tourId: number }> };
    expect(body.tours.map((t) => String(t.tourId))).toEqual(byLot);
    expect(String(queryMock.mock.calls[0][0])).not.toMatch(/ORDER BY\s+COALESCE\(ta\.base_price_override/);
  });

  it('оценка — только с отзывами; без отзывов — null, а не «0.0»', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        row({ tour_id: '1', operator_rating: '0.0', operator_review_count: 0 }),
        row({ tour_id: '2', operator_rating: '4.8', operator_review_count: 5 }),
        row({ tour_id: '3', operator_rating: '4.5', operator_review_count: null }),
      ],
    });
    const res = await dayRoute(req('http://localhost/api/availability/day?date=2099-07-19'));
    const body = await res.json() as { tours: Array<{ tourId: number; operator: { rating: number | null; reviewCount: number | null } }> };
    const op = new Map(body.tours.map((t) => [t.tourId, t.operator]));
    expect(op.get(1)).toMatchObject({ rating: null, reviewCount: null });
    expect(op.get(2)).toMatchObject({ rating: 4.8, reviewCount: 5 });
    expect(op.get(3)).toMatchObject({ rating: null, reviewCount: null });
    expect(String(queryMock.mock.calls[0][0])).toContain('p.review_count');
  });

  it('вид — словами общего словаря; неизвестный — null, а не служебное слово', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        row({ tour_id: '1', activity_type: 'jeep_safari' }),
        row({ tour_id: '2', activity_type: 'horseback' }),
        row({ tour_id: '3', activity_type: 'zorbing' }),
      ],
    });
    const res = await dayRoute(req('http://localhost/api/availability/day?date=2099-07-19'));
    const body = await res.json() as { tours: Array<{ tourId: number; activityLabel: string | null }> };
    const label = new Map(body.tours.map((t) => [t.tourId, t.activityLabel]));
    expect(label.get(1)).toBe('Джип-сафари');
    expect(label.get(2)).toBe('Конный маршрут');
    expect(label.get(3)).toBeNull();
  });

  it('кнопка вида находит все написания: jeep → jeep_safari и jeep', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await dayRoute(req('http://localhost/api/availability/day?date=2099-07-19&activity=jeep'));
    expect(String(queryMock.mock.calls[0][0])).toMatch(/t\.activity_type = ANY\(\$2::text\[\]\)/);
    expect(queryMock.mock.calls[0][1]).toEqual(['2099-07-19', ['jeep_safari', 'jeep']]);
  });
});

describe('/api/availability — месяц', () => {
  it('кнопки видов — из живых туров месяца, без повторов и служебных слов, без фильтра по виду', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: ['jeep', 'jeep_safari', 'horseback', 'zorbing', null, 'fishing'].map((activity_type) => ({ activity_type })) });
    const res = await monthRoute(req('http://localhost/api/availability?month=2099-07&activity=fishing'));
    const body = await res.json() as { activities: Array<{ value: string; label: string }> };
    expect(body.activities).toEqual([
      { value: 'jeep_safari', label: 'Джип-сафари' },
      { value: 'horseback', label: 'Конный маршрут' },
      { value: 'fishing', label: 'Рыбалка' },
    ]);
    // Список видов спрашивается без фильтра по виду: выбранная кнопка не прячет остальные.
    expect(queryMock.mock.calls[1][1]).toEqual(['2099-07-01', '2099-07-31']);
    expect(String(queryMock.mock.calls[1][0])).not.toContain('ANY(');
  });
});

// ── Страница ────────────────────────────────────────────────────────────────

const MONTH_OK = {
  success: true,
  days: [
    { date: '2026-11-17', tourCount: 2, freeSlots: 14, priceFrom: 3500, activities: ['horseback'], operators: 1 },
    { date: '2026-11-18', tourCount: 1, freeSlots: 6, priceFrom: 3500, activities: ['horseback'], operators: 1 },
  ],
  activities: [{ value: 'horseback', label: 'Конный маршрут' }],
};

function tour(id: number, rating: number | null, reviewCount: number | null) {
  return {
    tourId: id, title: `Тур ${id}`, description: null, activityType: 'horseback', activityLabel: 'Конный маршрут',
    locationName: null, price: 3500, priceUnit: 'per_person', durationHours: 2, durationType: null,
    freeSlots: 6, availableSlots: 12, groupSizeUnlimited: false, weatherStatus: 'ok',
    operator: { id: 'p1', name: 'Компания', verified: true, rating, reviewCount, slug: null, isPublic: null },
  };
}

function stubFetch(handler: (url: string) => { status: number; body: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const r = handler(url);
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  }));
}

describe('страница /calendar', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-16T12:00:00'));
  });

  it('при открытии выбран ближайший день с турами; правило порядка названо; звёзд без отзывов нет', async () => {
    stubFetch((url) => url.startsWith('/api/availability/day')
      ? { status: 200, body: { success: true, tours: [tour(1, null, null), tour(2, 4.8, 5)] } }
      : { status: 200, body: MONTH_OK });
    render(<CalendarClient />);
    expect(await screen.findByText(OFFER_ORDER_NOTE_DAY_RU)).toBeTruthy();
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain('/api/availability/day?date=2026-11-17');
    const first = screen.getByText('Тур 1').closest('.ds-card') as HTMLElement;
    const second = screen.getByText('Тур 2').closest('.ds-card') as HTMLElement;
    expect(within(first).queryByText(/0\.0|отзыв/)).toBeNull();
    expect(within(second).getByText('4.8')).toBeTruthy();
    expect(within(second).getByText('· 5 отзывов')).toBeTruthy();
  });

  it('кнопки видов — из ответа, без выдуманных; «слотов» нет', async () => {
    stubFetch((url) => url.startsWith('/api/availability/day')
      ? { status: 200, body: { success: true, tours: [] } }
      : { status: 200, body: MONTH_OK });
    render(<CalendarClient />);
    expect(await screen.findByRole('button', { name: 'Конный маршрут' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Эко-тур' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Джип-тур' })).toBeNull();
    expect(document.body.textContent).not.toContain('слотов');
    expect(await screen.findByText('2 дня')).toBeTruthy();
  });

  it('месяц не загрузился — сказано словами, а не «туров нет»', async () => {
    stubFetch(() => ({ status: 500, body: { success: false, error: 'Календарь временно не загружается' } }));
    render(<CalendarClient />);
    expect(await screen.findByText(/Календарь не загрузился/)).toBeTruthy();
    expect(screen.queryByText('В этом месяце нет открытых туров')).toBeNull();
  });

  it('день не загрузился — сказано словами, а не «нет доступных туров»', async () => {
    stubFetch((url) => url.startsWith('/api/availability/day')
      ? { status: 500, body: { success: false } }
      : { status: 200, body: MONTH_OK });
    render(<CalendarClient />);
    expect(await screen.findByText(/Туры на этот день не загрузились/)).toBeTruthy();
    expect(screen.queryByText('Нет доступных туров на этот день')).toBeNull();
  });

  it('в месяце правда нет туров — так и сказано', async () => {
    stubFetch(() => ({ status: 200, body: { success: true, days: [], activities: [] } }));
    render(<CalendarClient />);
    await waitFor(() => expect(screen.getByText('В этом месяце нет открытых туров')).toBeTruthy());
  });
});
