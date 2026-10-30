/**
 * Кабинет проката на сайте (/hub/carrier/rental, владелец 26.10: прокатчику
 * «Лагуны» — кабинет на сайте, как кнопки «Мои машины», «Заявки» и
 * «Календарь» в MAX).
 *
 * Сквозной путь на настоящей базе — список, «Беру» с отметкой дней, повтор
 * 409, календарь только своей машине — держит
 * tests/integration/car-rental.pg.test.ts. Здесь — что видит прокатчик:
 * «не загрузилось» не выдаётся за «нет», ответ на заявку сначала
 * подтверждается, вне пилота кнопок записи нет, день без отметки —
 * «не отмечено»; и исходы ответа — в HTTP-статусы.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { NextRequest } from 'next/server';

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: db.query } }));
vi.mock('@/lib/transfers/carrier-auth', () => ({
  requireCarrier: vi.fn(async () => ({ user: { userId: 'u-1', role: 'transfer' }, partnerId: '0aaa4f05-0000-4000-8000-0000000000p1' })),
}));

import RentalClient from '@/app/hub/carrier/rental/_RentalClient';
import { answerTellPlain, answerTellStatus } from '@/lib/rental/web-cabinet';
import { POST as markDay } from '@/app/api/hub/carrier/rental/calendar/route';
import { kamchatkaDate, shiftDate } from '@/lib/analytics/kamchatka-day';

const LEAD = '0aaa4f05-0000-4000-8000-0000000000a1';
const CAR = '0aaa4f05-0000-4000-8000-0000000000c1';

function cabinet(over: Record<string, unknown> = {}) {
  return {
    partnerName: 'Лагуна Прокат',
    canWrite: true,
    cars: [{ offerId: CAR, title: 'Tank-300', pricePerDay: 9000, priceIsFrom: false, deposit: 30000, active: true }],
    requests: [{
      leadId: LEAD, name: 'Анна', phone: '+79990001122', title: 'Tank-300',
      dateFrom: '2026-12-01', dateTo: '2026-12-02', answer: null,
    }],
    olderRequests: false,
    edits: [],
    ...over,
  };
}

const ok = (data: unknown, extra: Record<string, unknown> = {}) =>
  Promise.resolve(new Response(JSON.stringify({ success: true, data, ...extra }), { status: 200 }));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('экран «Прокат»', () => {
  it('машины, заявка с именем и телефоном; «Беру» сначала спрашивает и только потом пишет', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith(`/requests/${LEAD}`)) {
        expect(JSON.parse(String(init?.body))).toEqual({ answer: 'take' });
        return ok(undefined, { message: 'Ваш ответ: беру. Дни с 2026-12-01 по 2026-12-02 отмечены занятыми (2).' });
      }
      return ok(cabinet());
    });
    render(<RentalClient />);

    expect(await screen.findByText(/9\s000 ₽ за сутки/)).toBeTruthy();
    expect(screen.getByText(/залог 30\s000 ₽/)).toBeTruthy();
    const card = screen.getByTestId(`request-${LEAD}`);
    expect(within(card).getByText(/Анна · \+79990001122/)).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { name: /Беру/ }));
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/requests/'))).toBe(false);
    expect(within(card).getByRole('group', { name: 'Подтверждение ответа' }).textContent).toMatch(/Изменить ответ потом нельзя/);

    fireEvent.click(within(card).getByRole('button', { name: 'Да, ответить' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/отмечены занятыми \(2\)/));
  });

  it('списки не прочитались — «не смогли прочитать», а не «нет»', async () => {
    fetchMock.mockImplementation(() => ok(cabinet({ cars: null, requests: null, edits: null })));
    render(<RentalClient />);
    expect(await screen.findByText(/Не смогли прочитать машины/)).toBeTruthy();
    expect(screen.getByText(/Не смогли прочитать заявки/)).toBeTruthy();
    expect(screen.queryByText('Заявок на прокат пока нет.')).toBeNull();
  });

  it('вне пилота — списки видны, кнопок ответа и отметки нет, причина названа', async () => {
    fetchMock.mockImplementation((url: string) => (String(url).includes('/calendar')
      ? ok({ today: '2026-10-26', days: [{ day: '2026-10-26', label: '26 окт', busy: null }] })
      : ok(cabinet({ canWrite: false }))));
    render(<RentalClient />);
    expect(await screen.findByText(/участникам пилота проката/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Беру/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Календарь/ }));
    const day = await screen.findByRole('button', { name: /26 окт/ });
    expect((day as HTMLButtonElement).disabled).toBe(true);
  });

  it('календарь: день без отметки — «не отмечено»; отметка уходит своей машине и читается заново', async () => {
    let busy: boolean | null = null;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/calendar') && init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ offerId: CAR, day: '2026-10-27', busy: true });
        busy = true;
        return ok(undefined);
      }
      if (String(url).includes('/calendar')) {
        return ok({ today: '2026-10-26', days: [{ day: '2026-10-27', label: '27 окт', busy }] });
      }
      return ok(cabinet());
    });
    render(<RentalClient />);
    fireEvent.click(await screen.findByRole('button', { name: /Календарь/ }));
    const day = await screen.findByRole('button', { name: /27 окт/ });
    expect(day.textContent).toContain('не отмечено');
    fireEvent.click(day);
    fireEvent.click(screen.getByRole('button', { name: 'Занята' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /27 окт/ }).textContent).toContain('занята'));
  });
});

describe('исход ответа — в статус и текст без разметки', () => {
  it.each([
    [{ kind: 'take', from: '2026-12-01', to: '2026-12-02', marked: 2 }, 200],
    [{ kind: 'decline' }, 200],
    [{ kind: 'take_no_car' }, 200],
    [{ kind: 'already', answer: 'take' }, 409],
    [{ kind: 'missing' }, 404],
    [{ kind: 'not_yours' }, 403],
    [{ kind: 'not_pilot' }, 403],
    [{ kind: 'retry' }, 503],
    [{ kind: 'unread' }, 503],
  ] as const)('%o → %i', (tell, status) => {
    expect(answerTellStatus(tell)).toBe(status);
    expect(answerTellPlain(tell)).not.toMatch(/<\/?b>/);
  });
});

describe('отметка календаря: чего быть не должно', () => {
  const mark = (day: string) => markDay(new NextRequest('https://vedarai.ru/api/hub/carrier/rental/calendar', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ offerId: CAR, day, busy: true }),
  }));
  const writes = () => db.query.mock.calls.filter(([sql]) => /INSERT INTO rental_car_busy/.test(String(sql)));

  beforeEach(() => { db.query.mockReset(); });

  it('карточка вне пилота — 403, в базу не пишется', async () => {
    db.query.mockResolvedValue({ rows: [{ name: 'Прокат у залива', slug: 'bay-rental' }] });
    const res = await mark(shiftDate(kamchatkaDate(new Date()), 1));
    expect(res.status).toBe(403);
    expect(writes()).toEqual([]);
  });

  it('день вне ближайших 30 — 400, в базу не пишется', async () => {
    db.query.mockResolvedValue({ rows: [{ name: 'Лагуна Прокат', slug: 'laguna-prokat' }] });
    const res = await mark(shiftDate(kamchatkaDate(new Date()), 30));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/вне ближайших 30/);
    expect(writes()).toEqual([]);
  });
});
