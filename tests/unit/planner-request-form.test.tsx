/**
 * Форма заявки /planner целиком (проверка сценариев 07.11): человек отметил
 * «укачивает на воде», собрал план, открыл «Запросить подробное
 * предложение» — над контактами видна сводка, и её строки ровно те, что
 * получаются из отправленного `source_data`. Что видел — то и ушло.
 *
 * Обвязка — как у сквозной приёмки планера (planner-calendar-days-ui):
 * навигация и динамические куски подменены, ответы API — заглушкой fetch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import React from 'react';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/planner',
}));
vi.mock('next/dynamic', () => ({ default: () => function DynamicStub() { return null; } }));
vi.mock('@/hooks/useMyReferralCode', () => ({ useMyReferralCode: () => null }));
vi.mock('@/lib/funnel/beacon', () => ({ funnelBeacon: vi.fn() }));
vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>();
  const { createElement } = await import('react');
  type Props = { children?: React.ReactNode; className?: string };
  return {
    ...actual,
    useDragControls: () => ({ start: () => undefined }),
    Reorder: {
      Group: ({ children, className }: Props) => createElement('ul', { className }, children),
      Item: ({ children, className }: Props) => createElement('li', { className }, children),
    },
  };
});

import { PlannerClient } from '@/app/planner/_PlannerClient';
import { tripFactsOf, tripRequestLines } from '@/lib/planner/trip-request-lines';

const ARRIVAL = '2030-07-10';
const day = (n: number, type: string, title: string, extra: Record<string, unknown> = {}) => ({
  day: n, type, zone: 'avachinsky', title, description: '', activityType: type === 'activity' ? 'volcano' : type,
  priceFrom: 0, priceTo: 0, coords: [53.2, 158.6 + n / 100], defaultTransport: 'walking', allowedTransports: ['walking'],
  difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: [], ...extra,
});
const DAYS = [
  day(1, 'arrival', 'Прилёт днём'),
  day(2, 'activity', 'Авачинский вулкан', { realTour: { tourId: 't-1', priceUnit: 'per_person', maxParticipants: 10, lodgingIncluded: false, operatorName: 'Оператор' }, realPrice: 10000 }),
  day(3, 'departure', 'Сборы и вылет'),
];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const json = u.startsWith('/api/planner/recommend')
      ? { success: true, data: { zones: [], warnings: [], itinerary: '', days: DAYS,
        priceBreakdown: { activities: [0, 0], accommodation: [0, 0], transport: [0, 0], perPersonTotal: [0, 0] } } }
      : { success: true, data: [], tours: [] };
    return { ok: true, json: async () => json } as Response;
  }));
});

const next = () => fireEvent.click(screen.getByRole('button', { name: /Дальше/ }));
const posted = (url: string) => {
  const call = vi.mocked(fetch).mock.calls.filter(([u]) => u === url).at(-1);
  if (!call) throw new Error(`запроса ${url} не было`);
  return JSON.parse(String(call[1]!.body));
};

describe('форма заявки планера: сводка = отправленное', () => {
  it('«укачивает на воде» видно в сводке и уходит в заявку; строки сводки — из тела заявки', async () => {
    render(<PlannerClient initialUserId="u-1" />);
    fireEvent.change(screen.getByLabelText('Дата прилёта'), { target: { value: ARRIVAL } });
    fireEvent.change(screen.getByLabelText('Дата отъезда'), { target: { value: '2030-07-17' } });
    // Галочка «укачивает» стоит на одном из шагов анкеты — ищем по пути.
    let ticked = false;
    for (let i = 0; i < 3; i++) {
      next();
      const box = screen.queryByLabelText(/Укачивает на воде/);
      if (box && !ticked) { fireEvent.click(box); ticked = true; }
    }
    expect(ticked, 'галочки «Укачивает на воде» нет в анкете').toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Вулканы/ }));
    fireEvent.click(screen.getByRole('button', { name: /Собрать маршрут/ }));
    await screen.findByTestId('price-estimate');

    fireEvent.click(screen.getAllByRole('button', { name: /Запросить подробное предложение/ })[0]!);
    const summary = screen.getByRole('region', { name: 'Что уйдёт в заявке' });
    const shownLines = within(summary).getAllByRole('listitem').map((li) => li.textContent);
    expect(shownLines).toContain('Даты: 10.07.2030 — 17.07.2030 (8 дн.)');
    expect(shownLines).toContain('Пожелания из анкеты: укачивает на воде — без катеров, где можно');
    expect(shownLines.some((l) => l?.startsWith('Группа: 2 взр.'))).toBe(true);

    fireEvent.change(screen.getByPlaceholderText('Ваше имя'), { target: { value: 'Тест' } });
    fireEvent.change(screen.getByPlaceholderText('+7 900 000-00-00'), { target: { value: '+79990000000' } });
    fireEvent.click(document.getElementById('pd-consent-planner')!);
    fireEvent.click(screen.getByRole('button', { name: 'Отправить заявку' }));
    const sd = posted('/api/leads').source_data as Record<string, unknown>;
    expect(sd).toMatchObject({ source: 'trip_planner', party: { adults: 2, children: [] }, wishes: { seasickness: true, risk_mode: 'safe_only' } });
    expect(tripRequestLines(tripFactsOf(sd))).toEqual(shownLines);
  });
});
