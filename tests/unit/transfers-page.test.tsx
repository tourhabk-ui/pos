/**
 * Витрина /transfers (владелец 13.10: «что за поиск в трансфере… не понимаю
 * смысл формы»). Судится рендером — тем, что видит человек:
 *
 *   · сначала то, что есть: машина под заказ с ценой за машину; места в
 *     поездках — ниже, списком на 60 дней, без формы дат («с даты / по дату /
 *     Найти места» на проде всегда отвечала «никто не едет», а настоящее
 *     предложение лежало ниже сгиба);
 *   · у поездок три исхода: список / пусто — словами, с дорогой к машине под
 *     заказ / не смогли проверить — «это не значит, что мест нет»; без
 *     searched: true пустой ответ не выдаётся за «мест нет»;
 *   · ссылка из плана открывает свои даты и места, выделяет поездку и даёт
 *     «все поездки на 60 дней»;
 *   · «Мои заказы мест» — только когда есть что показать;
 *   · запрос мест — за входом; шапка — одна строка сути на телефоне.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const auth = vi.hoisted(() => ({ user: null as null | { id: string }, isLoading: false }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/shared/BottomNav', () => ({ default: () => null }));
vi.mock('@/components/marketplace/SbpQrPayment', () => ({ default: () => null }));
vi.mock('@/components/transfers/CharterCard', () => ({
  CharterCard: ({ carrier }: { carrier: { name: string } }) => <article>Карточка: {carrier.name}</article>,
}));

import TransfersClient, { TRIPS_WINDOW_DAYS } from '@/app/transfers/(list)/_TransfersClient';
import type { CharterState } from '@/lib/transfers/charter-format';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const CHARTER = { state: 'ok', carriers: [{ partnerId: 'p-1', name: 'Шатун' }] } as unknown as CharterState;
const TODAY = '2026-10-14';

const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const trip = (id: string, over: Record<string, unknown> = {}) => ({
  id, trip_date: '2026-10-20', from_text: 'Петропавловск-Камчатский', to_text: 'Вулкан Горелый', departure_note: null,
  seats_total: 20, seats_free: 6, price_per_seat: '3500', partner_name: 'Шатун', vehicle_kind: 'vahtovka', vehicle_title: 'КамАЗ', ...over,
});
const tripsUrl = () => String(fetchMock.mock.calls.find(([u]) => String(u).startsWith('/api/carrier-trips?'))?.[0] ?? '');

beforeEach(() => {
  fetchMock.mockReset();
  auth.user = null;
  auth.isLoading = false;
});

describe('порядок: сначала то, что есть', () => {
  it('машина под заказ — первой, места в поездках — ниже; формы дат нет', async () => {
    fetchMock.mockResolvedValue(reply(200, { success: true, searched: true, trips: [] }));
    const { container } = render(<TransfersClient charter={CHARTER} today={TODAY} />);
    const h2 = [...container.querySelectorAll('h2')].map((h) => h.textContent);
    expect(h2).toEqual(['Машина под заказ', 'Места в поездках']);
    expect(screen.getByText('Карточка: Шатун')).toBeTruthy();
    // Ни полей дат, ни кнопки «Найти места».
    expect(container.querySelector('input[type="date"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /Найти места/ })).toBeNull();
    await screen.findByTestId('trips-empty');
  });

  it('шапка: на телефоне одна строка сути, подробности — только с sm', () => {
    fetchMock.mockResolvedValue(reply(200, { success: true, searched: true, trips: [] }));
    render(<TransfersClient charter={CHARTER} today={TODAY} />);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('Трансферы');
    expect(h1.className).toContain('text-[28px]');
    const lead = h1.nextElementSibling as HTMLElement;
    expect(lead.textContent).toContain('Машина целиком под заказ — по прайсу перевозчика, цена за машину.');
    expect(lead.querySelector('span.hidden')?.className).toContain('sm:inline');
    expect(lead.querySelector('span.hidden')?.textContent).toContain('места в поездках');
  });

  it('перевозчиков нет — словами; не прочитались — «сбой, это не значит, что их нет»', () => {
    fetchMock.mockResolvedValue(reply(200, { success: true, searched: true, trips: [] }));
    const { unmount } = render(<TransfersClient charter={{ state: 'ok', carriers: [] }} today={TODAY} />);
    expect(screen.getByText('Перевозчиков с прайсом под заказ пока нет.')).toBeTruthy();
    unmount();
    render(<TransfersClient charter={{ state: 'failed' }} today={TODAY} />);
    expect(screen.getByText('Не смогли проверить вахтовки под заказ')).toBeTruthy();
    expect(screen.getByText(/Это не значит, что их нет/)).toBeTruthy();
  });
});

describe('места в поездках: три исхода', () => {
  it('без ссылки — ближайшие 60 дней с сегодняшнего по Камчатке, одно место', async () => {
    fetchMock.mockResolvedValue(reply(200, { success: true, searched: true, trips: [] }));
    render(<TransfersClient charter={CHARTER} today={TODAY} />);
    await screen.findByTestId('trips-empty');
    expect(TRIPS_WINDOW_DAYS).toBe(60);
    expect(tripsUrl()).toBe('/api/carrier-trips?from=2026-10-14&to=2026-12-13&min_seats=1');
  });

  it('пусто — словами и с дорогой к машине под заказ', async () => {
    fetchMock.mockResolvedValue(reply(200, { success: true, searched: true, trips: [] }));
    render(<TransfersClient charter={CHARTER} today={TODAY} />);
    expect((await screen.findByTestId('trips-empty')).textContent)
      .toBe('В ближайшие 60 дней мест в поездках никто не выставил. Нужна машина — закажите её целиком выше.');
  });

  it('ответ без searched: true — «не смогли проверить», а не «мест нет»', async () => {
    fetchMock.mockResolvedValue(reply(200, { success: true, trips: [] }));
    render(<TransfersClient charter={CHARTER} today={TODAY} />);
    await screen.findByText('Не смогли проверить поездки');
    expect(screen.getByText(/Это не значит, что мест нет/)).toBeTruthy();
    expect(screen.queryByTestId('trips-empty')).toBeNull();
  });

  it('витрина ответила 503 — её словами', async () => {
    fetchMock.mockResolvedValue(reply(503, { success: false, searched: false, error: 'Не удалось проверить поездки — попробуйте позже.' }));
    render(<TransfersClient charter={CHARTER} today={TODAY} />);
    await screen.findByText('Не смогли проверить поездки');
    expect(screen.getByText(/Не удалось проверить поездки — попробуйте позже\. Это не значит, что мест нет\./)).toBeTruthy();
  });

  it('поездки есть — карточки с местами и ценой; гостю — вход для запроса', async () => {
    fetchMock.mockResolvedValue(reply(200, { success: true, searched: true, trips: [trip('t-1')] }));
    render(<TransfersClient charter={CHARTER} today={TODAY} />);
    const card = await waitFor(() => {
      const el = document.getElementById('trip-t-1');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(card.textContent).toContain('Петропавловск-Камчатский — Вулкан Горелый');
    expect(card.textContent).toContain('6 из 20');
    // Разряды — неразрывным пробелом (toLocaleString), отсюда \s.
    expect(card.textContent).toMatch(/3\s500 ₽ за место/);
    expect(within(card).getByRole('link', { name: 'Войти, чтобы запросить места' }).getAttribute('href')).toBe('/auth/login?from=/transfers');
  });
});

describe('ссылка из плана', () => {
  const TRIP = '33333333-3333-4333-8333-333333333333';
  it('свои даты и места, поездка выделена; «все поездки» — окно на 60 дней', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    fetchMock.mockResolvedValue(reply(200, { success: true, searched: true, trips: [trip(TRIP, { trip_date: '2026-11-03' })] }));
    render(<TransfersClient charter={CHARTER} today={TODAY} prefill={{ from: '2026-11-03', to: '2026-11-03', seats: 3, tripId: TRIP }} />);
    await waitFor(() => expect(document.getElementById(`trip-${TRIP}`)).not.toBeNull());
    expect(tripsUrl()).toBe('/api/carrier-trips?from=2026-11-03&to=2026-11-03&min_seats=3');
    expect(document.getElementById(`trip-${TRIP}`)!.className).toContain('ring-[var(--accent)]');
    expect(screen.getByText('Поездки на ваши даты: 3 ноября, мест от 3')).toBeTruthy();

    fetchMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Все поездки на 60 дней' }));
    await waitFor(() => expect(tripsUrl()).toBe('/api/carrier-trips?from=2026-10-14&to=2026-12-13&min_seats=1'));
    await waitFor(() => expect(screen.queryByText(/Поездки на ваши даты/)).toBeNull());
  });

  it('на даты из плана пусто — сказано про эти даты, без отсылки «на 60 дней»', async () => {
    fetchMock.mockResolvedValue(reply(200, { success: true, searched: true, trips: [] }));
    render(<TransfersClient charter={CHARTER} today={TODAY} prefill={{ from: '2026-11-03', to: '2026-11-05', seats: 1 }} />);
    expect((await screen.findByTestId('trips-empty')).textContent).toBe('На эти даты мест в поездках никто не выставил.');
    expect(screen.getByText('Поездки на ваши даты: 3 ноября — 5 ноября')).toBeTruthy();
  });
});

describe('мои заказы мест', () => {
  const route = (bookings: unknown) => async (url: string) => String(url).startsWith('/api/carrier-trips/bookings')
    ? reply(200, { success: true, searched: true, bookings })
    : reply(200, { success: true, searched: true, trips: [] });

  it('вошёл, заказов нет — блока нет вовсе (не «Заказов пока нет» на пустой витрине)', async () => {
    auth.user = { id: 'u-1' };
    fetchMock.mockImplementation(route([]));
    render(<TransfersClient charter={CHARTER} today={TODAY} />);
    await screen.findByTestId('trips-empty');
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/carrier-trips/bookings')).toBe(true));
    expect(screen.queryByRole('heading', { name: 'Мои заказы мест' })).toBeNull();
  });

  it('заказ есть — блок с ним; поездка прошла — ссылка на отзыв о перевозчике', async () => {
    auth.user = { id: 'u-1' };
    fetchMock.mockImplementation(route([{
      id: 'b-1', trip_date: '2026-10-12', from_text: 'Елизово', to_text: 'Вачкажец', departure_note: null, partner_name: 'Шатун',
      vehicle_title: 'КамАЗ', seats: 2, price: null, price_per_seat: null, status: 'confirmed', decline_reason: null,
      payment_status: 'unpaid', review_href: '/transfers/shatun/review?seat=b-1', reviewed: false,
    }]));
    render(<TransfersClient charter={CHARTER} today={TODAY} />);
    const h = await screen.findByRole('heading', { name: 'Мои заказы мест' });
    const block = h.closest('section') as HTMLElement;
    expect(block.textContent).toContain('Елизово — Вачкажец');
    expect(within(block).getByRole('link', { name: 'Оставить отзыв о перевозчике' }).getAttribute('href')).toBe('/transfers/shatun/review?seat=b-1');
  });

  it('заказы не прочитались — так и сказано', async () => {
    auth.user = { id: 'u-1' };
    fetchMock.mockImplementation(async (url: string) => String(url).startsWith('/api/carrier-trips/bookings')
      ? reply(503, { success: false, searched: false, error: 'Не удалось проверить заказы — попробуйте позже' })
      : reply(200, { success: true, searched: true, trips: [] }));
    render(<TransfersClient charter={CHARTER} today={TODAY} />);
    expect((await screen.findByText(/Не смогли проверить заказы/)).textContent).toContain('Не удалось проверить заказы');
  });
});
