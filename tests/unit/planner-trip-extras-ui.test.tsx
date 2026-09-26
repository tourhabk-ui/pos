/**
 * Сторож экрана: «Что ещё нужно» в планере (решение владельца 26.09).
 *
 *   — на шаге «Как хотите ехать» три переключателя: жильё, трансфер из
 *     аэропорта, машина; трансфер — ОДИН на всю анкету (прежняя галочка
 *     «встреча в аэропорту» на первом шаге переехала сюда, а не задвоилась);
 *   — отмеченное уходит в /api/planner/trip-extras вместе с текущими днями;
 *     здоровье туда не уходит;
 *   — результат показывает настоящие варианты, «на платформе нет» с каталогом,
 *     «не смогли проверить» при отказе и честное «пока нет» про машину;
 *   — оценка движка подписана оценкой, чтобы не спутать её с предложениями.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import React from 'react';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/planner',
}));
vi.mock('next/dynamic', () => ({ default: () => function DynamicStub() { return null; } }));
vi.mock('@/hooks/useMyReferralCode', () => ({ useMyReferralCode: () => null }));
vi.mock('@/lib/funnel/beacon', () => ({ funnelBeacon: vi.fn() }));

import { PlannerClient } from '@/app/planner/_PlannerClient';

type Call = { url: string; body: Record<string, unknown> | null };
let calls: Call[] = [];

const day = (n: number, type: string, zone: string, extra: Record<string, unknown> = {}) => ({
  day: n, type, zone, title: `День ${n}`, description: '', activityType: 'rest',
  priceFrom: 0, priceTo: 0, coords: [53, 158], defaultTransport: 'walking', allowedTransports: ['walking'],
  difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: [], ...extra,
});

const RECOMMENDATION = {
  zones: [], warnings: [], itinerary: '',
  days: [
    day(1, 'arrival', 'avachinsky'),
    day(2, 'activity', 'western', { realTour: { lodgingIncluded: true } }),
    day(3, 'departure', 'avachinsky'),
  ],
  priceBreakdown: { activities: [1000, 2000], accommodation: [3000, 5000], transport: [2500, 5000], perPersonTotal: [6500, 12000] },
};

const EXTRAS = {
  lodging: {
    state: 'checked', nightsInTours: 1, unzonedCount: 4,
    stays: [
      { zone: 'avachinsky', zoneName: 'Авачинская зона', checkIn: '2030-08-03', checkOut: '2030-08-04', nights: 1,
        result: { state: 'ok', items: [{ id: 'acc-1', name: 'Дом у вулкана', type: 'guesthouse', priceFrom: null, rating: null, reviewCount: 0, isVerified: true }] } },
      { zone: 'western', zoneName: 'Западная зона', checkIn: '2030-08-05', checkOut: '2030-08-06', nights: 1,
        result: { state: 'empty' } },
    ],
  },
  transfer: {
    state: 'ok', window: { from: '2030-08-03', to: '2030-08-12', seats: 2 },
    items: [{ id: 't1', tripDate: '2030-08-03', departureNote: '10:00', fromText: 'Аэропорт Елизово', toText: 'Паратунка',
      seatsFree: 6, seatsTotal: 8, pricePerSeat: 1500, vehicleKind: 'minibus', vehicleTitle: 'Спринтер', partnerName: 'Перевозчик' }],
  },
  car: { state: 'not_offered', message: 'Аренды автомобилей на платформе пока нет', hint: 'Доехать можно трансфером перевозчика или выбрать тур, где транспорт уже включён.' },
};

let extrasReply: { ok: boolean; json: unknown } = { ok: true, json: { success: true, data: EXTRAS } };

beforeEach(() => {
  calls = [];
  extrasReply = { ok: true, json: { success: true, data: EXTRAS } };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ url: String(url), body });
    if (String(url).startsWith('/api/planner/trip-extras')) {
      return { ok: extrasReply.ok, json: async () => extrasReply.json } as Response;
    }
    const json = String(url).startsWith('/api/planner/recommend')
      ? { success: true, data: RECOMMENDATION }
      : { success: true, data: [], tours: [] };
    return { ok: true, json: async () => json } as Response;
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const next = () => fireEvent.click(screen.getByRole('button', { name: /Дальше/ }));

function toStep3() {
  render(<PlannerClient />);
  fireEvent.change(screen.getByLabelText('Дата прилёта'), { target: { value: '2030-08-03' } });
  fireEvent.change(screen.getByLabelText('Дата отъезда'), { target: { value: '2030-08-12' } });
  next();
  next();
}

function build() {
  next();
  fireEvent.click(screen.getByRole('button', { name: /Вулканы/ }));
  fireEvent.click(screen.getByRole('button', { name: /Собрать маршрут/ }));
}

const need = (key: string) => document.querySelector(`[data-need="${key}"]`) as HTMLButtonElement;

describe('шаг 3: «Что ещё нужно»', () => {
  it('три переключателя, трансфер — один на всю анкету', () => {
    render(<PlannerClient />);
    // На первом шаге галочки трансфера больше нет — она переехала на шаг 3.
    expect(screen.queryByText(/Встреча в аэропорту/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Дата прилёта'), { target: { value: '2030-08-03' } });
    fireEvent.change(screen.getByLabelText('Дата отъезда'), { target: { value: '2030-08-12' } });
    next();
    next();
    const block = screen.getByTestId('needs-block');
    expect(within(block).getByText('Что ещё нужно')).toBeTruthy();
    expect(within(block).getAllByRole('button').map((b) => b.getAttribute('data-need'))).toEqual(['lodging', 'transfer', 'car']);
    expect(within(block).getByText('Трансфер из аэропорта')).toBeTruthy();
    expect(within(block).getByText('Машина напрокат')).toBeTruthy();
    for (const b of within(block).getAllByRole('button')) {
      expect(b.getAttribute('aria-pressed')).toBe('false');
      expect(b.className).toMatch(/min-h-\[44px\]/);
    }
    fireEvent.click(need('lodging'));
    expect(need('lodging').getAttribute('aria-pressed')).toBe('true');
  });

  it('ничего не отмечено — трансферы и жильё не спрашиваются', async () => {
    toStep3();
    build();
    await waitFor(() => expect(calls.some((c) => c.url === '/api/planner/recommend')).toBe(true));
    await new Promise((r) => setTimeout(r, 400));
    expect(calls.some((c) => c.url === '/api/planner/trip-extras')).toBe(false);
    expect(screen.queryByTestId('trip-extras')).toBeNull();
  });
});

describe('результат: настоящее, пустое, непроверенное, честное «нет»', () => {
  it('отмеченное уходит с текущими днями; здоровье — нет', async () => {
    render(<PlannerClient />);
    fireEvent.change(screen.getByLabelText('Дата прилёта'), { target: { value: '2030-08-03' } });
    fireEvent.change(screen.getByLabelText('Дата отъезда'), { target: { value: '2030-08-12' } });
    next();
    fireEvent.change(screen.getByLabelText(/Ограничения по здоровью/), { target: { value: 'астма' } });
    next();
    fireEvent.click(need('lodging'));
    fireEvent.click(need('transfer'));
    fireEvent.click(need('car'));
    build();

    await waitFor(() => expect(calls.some((c) => c.url === '/api/planner/trip-extras')).toBe(true));
    const body = calls.find((c) => c.url === '/api/planner/trip-extras')?.body ?? {};
    expect(body.needs).toEqual({ lodging: true, transfer: true, car: true });
    expect(body.arrivalDate).toBe('2030-08-03');
    expect(body.departureDate).toBe('2030-08-12');
    expect(body.adults).toBe(2);
    expect(body.days).toEqual([
      { day: 1, type: 'arrival', zone: 'avachinsky', lodgingIncluded: null },
      { day: 2, type: 'activity', zone: 'western', lodgingIncluded: true },
      { day: 3, type: 'departure', zone: 'avachinsky', lodgingIncluded: null },
    ]);
    expect(JSON.stringify(body)).not.toContain('астма');

    const section = await screen.findByTestId('trip-extras');
    // Жильё: настоящий объект со ссылкой, цена не выдумана.
    const link = within(section).getByText('Дом у вулкана').closest('a');
    expect(link?.getAttribute('href')).toBe('/accommodations/acc-1');
    expect(within(section).getByText('цена не указана')).toBeTruthy();
    // Пустая зона — честно и с каталогом.
    expect(within(section).getByText('На ваши даты свободного жилья в этой зоне на платформе нет.')).toBeTruthy();
    expect(within(section).getByText('Весь каталог жилья').closest('a')?.getAttribute('href')).toBe('/accommodations');
    expect(within(section).getByText(/без разметки зоны: 4/)).toBeTruthy();
    // Трансфер: маршрут, свободные места, цена, витрина перевозчиков.
    expect(within(section).getByText('Аэропорт Елизово — Паратунка')).toBeTruthy();
    expect(within(section).getByText(/свободно 6 из 8/)).toBeTruthy();
    expect(within(section).getByText(/в день прилёта/)).toBeTruthy();
    expect(within(section).getByText('Запросить место').closest('a')?.getAttribute('href')).toBe('/transfers');
    // Машина — «пока нет», без ссылок.
    const car = within(section).getByTestId('extras-car');
    expect(car.textContent).toMatch(/Аренды автомобилей на платформе пока нет/);
    expect(car.querySelector('a')).toBeNull();

    // Оценка движка подписана оценкой.
    const estimate = screen.getByTestId('price-estimate');
    expect(within(estimate).getByText('Оценка стоимости')).toBeTruthy();
    expect(within(estimate).getByText('Размещение, оценка')).toBeTruthy();
    expect(within(estimate).getByText('Транспорт, оценка')).toBeTruthy();
  });

  it('отказ сервера — «не смогли проверить», а не «вариантов нет»', async () => {
    extrasReply = { ok: false, json: { success: false, error: 'Слишком много запросов' } };
    toStep3();
    fireEvent.click(need('lodging'));
    build();
    const section = await screen.findByTestId('trip-extras');
    await waitFor(() => expect(section.textContent).toMatch(/Не смогли проверить жильё и трансферы/));
    expect(section.textContent).not.toMatch(/на платформе нет/);
  });
});
