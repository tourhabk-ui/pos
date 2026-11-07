/**
 * Страница сохранённой поездки показывает то, о чём план предупреждал на день
 * сохранения, и что человек ещё просил; номер дня — календарный (аудит
 * планировщика 07.11, волна 2.3: H6, H7). Запись этих полей —
 * tests/unit/trip-write.test.ts, сохранение из планировщика —
 * tests/unit/planner-save-share.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import React from 'react';

vi.mock('@/components/auth/Protected', () => ({
  Protected: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

import { TripDetailClient } from '@/app/hub/tourist/trips/[id]/_TripDetailClient';

const base = { zone: 'avachinsky', activityType: 'volcano', coords: [53, 158], defaultTransport: 'walking', priceFrom: 0, priceTo: 0 };
const DAY1 = { ...base, day: 1, type: 'arrival', title: 'Прилёт днём' };
const DAY2 = { ...base, day: 2, type: 'activity', title: 'Авачинский вулкан', dayWarnings: ['Только с гидом: сложный подъём'] };
const DAY3 = { ...base, day: 3, type: 'departure', title: 'Сборы и вылет' };
const TRIP = {
  id: 'trip-1', title: 'Маршрут', arrival_date: '2030-08-01', departure_date: '2030-08-03',
  flight_arrival: null, flight_departure: null, places: [], activities: ['volcano'], transport_by_day: {},
  // 03:00 UTC — уже 15:00 того же дня на Камчатке.
  created_at: '2030-07-01T00:00:00Z', updated_at: '2030-07-02T03:00:00Z',
  party: { adults: 2, children: [], budgetTier: 'comfort', tripOrigin: 'visitor' },
  days: [DAY1, DAY2, DAY3],
  needs_airport_transfer: false, needs_lodging: true, needs_car: true,
  warnings: [
    { type: 'season', severity: 'info', message: 'Конец сезона' },
    { type: 'mchs', severity: 'critical', message: 'Группу регистрируют в МЧС заранее' },
  ],
};

let tripReply: unknown = TRIP;
beforeEach(() => {
  tripReply = TRIP;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (String(url).startsWith('/api/trips/') ? { success: true, data: tripReply } : { success: true }),
  }) as Response));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const text = (el: Element) => (el.textContent ?? '').replace(/ /g, ' ');

async function sendLead() {
  await screen.findAllByTestId('trip-day');
  fireEvent.click(screen.getByRole('button', { name: /Запросить подробное предложение/ }));
  fireEvent.change(screen.getByPlaceholderText('Ваше имя'), { target: { value: 'Тест' } });
  fireEvent.change(screen.getByPlaceholderText('+7 900 000-00-00'), { target: { value: '+70000000000' } });
  fireEvent.click(document.getElementById('pd-consent-trip')!);
  fireEvent.click(screen.getByRole('button', { name: /Отправить заявку/ }));
  const call = vi.mocked(fetch).mock.calls.find(([url]) => url === '/api/leads');
  expect(call, 'заявка не ушла').toBeDefined();
  return JSON.parse(String(call![1]!.body)).source_data;
}

describe('предупреждения плана на странице поездки (H7)', () => {
  it('снимок с датой и ссылкой на свежую обстановку; главное — первым', async () => {
    render(<TripDetailClient tripId="trip-1" />);
    const block = await screen.findByTestId('trip-plan-warnings');
    expect(text(block)).toContain('на день сохранения, 02.07.2030');
    expect(within(block).getByRole('link', { name: /Обстановка/ }).getAttribute('href')).toBe('/safety');
    const items = within(block).getAllByRole('listitem').map(text);
    expect(items[0]).toBe('МЧСГруппу регистрируют в МЧС заранее');
    expect(items[1]).toBe('Конец сезона');
  });

  it('предупреждение дня — под своим днём', async () => {
    render(<TripDetailClient tripId="trip-1" />);
    const days = await screen.findAllByTestId('trip-day');
    expect(text(days[1]!)).toContain('Только с гидом: сложный подъём');
    expect(text(days[0]!)).not.toContain('Только с гидом');
  });

  it('не записано или пусто — блока нет', async () => {
    tripReply = { ...TRIP, warnings: null };
    render(<TripDetailClient tripId="trip-1" />);
    await screen.findAllByTestId('trip-day');
    expect(screen.queryByTestId('trip-plan-warnings')).toBeNull();
    cleanup();
    tripReply = { ...TRIP, warnings: [] };
    render(<TripDetailClient tripId="trip-1" />);
    await screen.findAllByTestId('trip-day');
    expect(screen.queryByTestId('trip-plan-warnings')).toBeNull();
  });
});

describe('номер дня — календарный', () => {
  it('у поездки с пропуском дня — 1 и 3, как в смете и на странице по ссылке', async () => {
    tripReply = { ...TRIP, days: [DAY1, DAY3] };
    render(<TripDetailClient tripId="trip-1" />);
    const days = await screen.findAllByTestId('trip-day');
    expect(days.map((d) => /^\d+/.exec(text(d))?.[0])).toEqual(['1', '3']);
  });
});

describe('что ещё нужно — в заявке из поездки (H6)', () => {
  it('записано — в плане заявки', async () => {
    render(<TripDetailClient tripId="trip-1" />);
    const sd = await sendLead();
    expect(sd.plan.needs).toEqual({ lodging: true, transfer: false, car: true });
  });

  it('поездка до 07.11 (не записано) — заявка не говорит «не нужно»', async () => {
    tripReply = { ...TRIP, needs_lodging: null, needs_car: null };
    render(<TripDetailClient tripId="trip-1" />);
    const sd = await sendLead();
    expect(sd.plan).toBeDefined();
    expect(sd.plan).not.toHaveProperty('needs');
  });
});
