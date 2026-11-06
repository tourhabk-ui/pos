/**
 * Страница плана поездки /trip/[token] говорит то же, что знает план (пруф с
 * прода 06.11).
 *
 * План внешнего ИИ на 10–14.07.2027 для двоих: на 11.07 стоял тур на Горелый,
 * ответ агенту прямо говорил «в ваши даты свободных мест нет» (ближайшая —
 * 15.07), а страница плана показывала цену и «оставить заявку» без единого
 * слова. Причины две: share-API писал места только при remaining > 0, а
 * «мест нет», «расписания нет» и «не смогли проверить» молча становились
 * пустотой; и страница не рисовала предупреждения дня вовсе — закрытие парка,
 * «только с гидом», МЧС, которые движок кладёт в день.
 *
 * Проверка — исполнением: share-API на заглушках данных и рендер страницы.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { NextRequest } from 'next/server';
import React from 'react';

const m = vi.hoisted(() => ({
  readSharedPlan: vi.fn(),
  toursByIds: vi.fn(),
  topToursByActivity: vi.fn(),
  fetchAvailabilityForTour: vi.fn(),
  tourKeepsSchedule: vi.fn(),
}));

vi.mock('@/lib/trips/shared-plan', () => ({ readSharedPlan: m.readSharedPlan }));
vi.mock('@/lib/tours/top-tour-by-activity', () => ({ toursByIds: m.toursByIds, topToursByActivity: m.topToursByActivity }));
vi.mock('@/lib/planner', () => ({
  createPlannerCache: () => ({}),
  fetchAvailabilityForTour: m.fetchAvailabilityForTour,
  fetchForecastDays: async () => ({ ok: false }),
  fetchContingencyAlternatives: async () => [],
}));
vi.mock('@/lib/seat-requests/service', () => ({ tourKeepsSchedule: m.tourKeepsSchedule }));
vi.mock('next/dynamic', () => ({ default: () => function MapStub() { return null; } }));
vi.mock('@/hooks/useMyReferralCode', () => ({ useMyReferralCode: () => null }));
vi.mock('@/lib/funnel/beacon', () => ({ funnelBeacon: vi.fn() }));
vi.mock('@/app/trip/[token]/_OfflineSave', () => ({ OfflineSave: () => null }));

import { GET } from '@/app/api/trips/share/[token]/route';
import { TripShareClient, type Trip } from '@/app/trip/[token]/_TripShareClient';
import { dayAvailabilityLine } from '@/lib/trips/day-availability';

const TOKEN = '00000000-0000-4000-8000-000000000611';
/** Даты — от сегодняшнего дня: тест с зашитой датой — бомба с часовым механизмом. */
const isoIn = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const ARRIVAL = isoIn(200);
const dayDate = (n: number) => new Date(Date.parse(`${ARRIVAL}T00:00:00Z`) + (n - 1) * 86_400_000).toISOString().slice(0, 10);
const ddmm = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

const tour = (id: string, title: string) => ({
  id, slug: null, title, base_price: '15000', operator_name: 'Оператор', operator_slug: null, operator_public: false,
});
const day = (n: number, extra: Record<string, unknown> = {}) => ({
  day: n, type: 'activity', zone: 'avachinsky', title: `День ${n}`, activityType: 'volcano',
  priceFrom: 0, priceTo: 0, coords: [53.01, 158.65], defaultTransport: 'walking', ...extra,
});

describe('share-API: четыре исхода мест на дату дня', () => {
  beforeEach(() => {
    m.readSharedPlan.mockResolvedValue({
      kind: 'found',
      plan: {
        source: 'draft', id: TOKEN, title: 'План', arrival_date: ARRIVAL, departure_date: isoIn(206),
        places: [], activities: [], transport_by_day: {},
        days: [day(2), day(3), day(4), day(5), day(6)],
        day_tour_ids: { 2: '70', 3: '5', 4: '9', 5: '11', 6: '12' },
      },
    });
    m.toursByIds.mockResolvedValue({
      70: tour('70', 'Горелый и пещеры'), 5: tour('5', 'Летняя рыбалка'), 9: tour('9', 'Без расписания'),
      11: tour('11', 'База упала'), 12: tour('12', 'Расписание не прочиталось'),
    });
    m.topToursByActivity.mockResolvedValue({});
    m.fetchAvailabilityForTour.mockImplementation(async (id: string, from: string, to: string) => {
      if (id === '70') return from === to ? [] : [{ date: dayDate(6), remaining: 4 }];
      if (id === '5') return [{ date: from, remaining: 14 }];
      if (id === '11') throw Object.assign(new Error('timeout'), { code: '57014' });
      return [];
    });
    m.tourKeepsSchedule.mockImplementation(async (id: number) => (id === 70 ? true : id === 9 ? false : null));
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('мест нет — с ближайшей датой; есть — с числом; без расписания и «не смогли» — названы, а не молчат', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await GET(new NextRequest(`http://x/api/trips/share/${TOKEN}`), { params: Promise.resolve({ token: TOKEN }) });
    const body = await res.json() as { data: { availability: Record<string, unknown> } };
    expect(body.data.availability).toEqual({
      2: { date: dayDate(2), remaining: 0, state: 'none', next: dayDate(6) },
      3: { date: dayDate(3), remaining: 14, state: 'open' },
      4: { date: dayDate(4), remaining: 0, state: 'on_request' },
      5: { date: dayDate(5), remaining: 0, state: 'unread' },
      6: { date: dayDate(6), remaining: 0, state: 'unread' },
    });
    // Отказ базы — в лог с SQLSTATE, а не пустой catch.
    expect(err.mock.calls.some((c) => c.join(' ').includes('57014'))).toBe(true);
  });
});

describe('строка мест и действие у тура дня', () => {
  it('«мест нет» ведёт на ближайшую дату, а не на «оставить заявку» на занятую', () => {
    expect(dayAvailabilityLine({ date: '2027-07-11', remaining: 0, state: 'none', next: '2027-07-15' })).toEqual({
      tone: 'warn', text: 'на 11.07 свободных мест нет; ближайшая свободная дата — 15.07', cta: 'заявка на 15.07', ctaDate: '2027-07-15',
    });
    expect(dayAvailabilityLine({ date: '2027-07-11', remaining: 0, state: 'none' }).cta).toBe('другие даты');
    expect(dayAvailabilityLine({ date: '2027-07-11', remaining: 0, state: 'none' }).ctaDate).toBeNull();
    expect(dayAvailabilityLine({ date: '2027-07-12', remaining: 3 }).text).toBe('на 12.07 — 3 места');
    expect(dayAvailabilityLine({ date: '2027-07-12', remaining: 21, state: 'open' }).text).toBe('на 12.07 — 21 место');
    expect(dayAvailabilityLine({ date: '2027-07-12', remaining: 11, state: 'open' }).text).toBe('на 12.07 — 11 мест');
    expect(dayAvailabilityLine({ date: '2027-07-13', remaining: 0, state: 'on_request' }).text).toMatch(/^расписания в системе нет/);
    expect(dayAvailabilityLine({ date: '2027-07-14', remaining: 0, state: 'unread' })).toMatchObject({ text: 'места на 14.07 проверить не удалось — уточните на странице тура', ctaDate: null });
  });
});

describe('страница плана: предупреждения дня и честная строка мест', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => null } as Response)));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('день с туром без мест: строка «мест нет», ссылка на ближайшую дату; предупреждения дня видны', () => {
    const trip: Trip = {
      source: 'draft', id: TOKEN, title: 'План', arrival_date: ARRIVAL, departure_date: isoIn(206),
      places: [], activities: [], transport_by_day: {},
      days: [
        { ...day(2, { title: 'Восхождение на вулкан Горелый' }), dayWarnings: ['Закрытие парка по сводке от 02.11: «Маршруты закрыты». Перед выходом уточните у дирекции парка.', 'Рекомендуется гид — активная вулканическая зона'] } as Trip['days'][number],
        day(3, { title: 'Рыбалка' }) as Trip['days'][number],
      ],
      day_tours: { 2: tour('70', 'Горелый и пещеры'), 3: tour('5', 'Летняя рыбалка') },
      availability: {
        2: { date: dayDate(2), remaining: 0, state: 'none', next: dayDate(6) },
        3: { date: dayDate(3), remaining: 14, state: 'open' },
      },
    };
    render(<TripShareClient trip={trip} token={TOKEN} />);

    const warn = screen.getByRole('list', { name: 'Важно в день 2' });
    expect(within(warn).getByText(/^Закрытие парка по сводке от 02\.11/)).toBeTruthy();
    expect(within(warn).getByText('Рекомендуется гид — активная вулканическая зона')).toBeTruthy();

    const gorely = screen.getByRole('link', { name: `Горелый и пещеры: заявка на ${ddmm(dayDate(6))}` });
    expect(gorely.getAttribute('href')).toMatch(new RegExp(`\\?date=${dayDate(6)}$`));
    expect(screen.getByText(new RegExp(`на ${ddmm(dayDate(2))} свободных мест нет; ближайшая свободная дата — ${ddmm(dayDate(6))}`))).toBeTruthy();
    // У тура без мест на дату дня нет «оставить заявку» на эту дату.
    expect(screen.queryByRole('link', { name: 'Горелый и пещеры: оставить заявку' })).toBeNull();

    const fishing = screen.getByRole('link', { name: 'Летняя рыбалка: оставить заявку' });
    expect(fishing.getAttribute('href')).toMatch(new RegExp(`\\?date=${dayDate(3)}$`));
    expect(screen.getByText(new RegExp(`на ${ddmm(dayDate(3))} — 14 мест`))).toBeTruthy();
  });
});
