/**
 * Сторож экрана: смета /planner — смета ТЕКУЩЕГО плана (#2304).
 *
 * До 09.10 «Оценка стоимости» приходила с сервера один раз: человек удалял
 * день с туром, а цена плана оставалась прежней. Теперь смета считается из
 * дней после правки — тем же lib/planner/estimate, что у движка и Кузьмича.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
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

const day = (n: number, type: string, extra: Record<string, unknown> = {}) => ({
  day: n, type, zone: 'avachinsky', title: `День ${n}`, description: '', activityType: 'volcano',
  priceFrom: 0, priceTo: 0, coords: [53, 158], defaultTransport: 'walking', allowedTransports: ['walking'],
  difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: [], ...extra,
});

// Двое, местные (ни ночей дома, ни трансфера аэропорта): в смете только туры.
const RECOMMENDATION = {
  zones: [], warnings: [], itinerary: '',
  days: [
    day(1, 'activity', { title: 'Авачинский вулкан', realPrice: 10000,
      realTour: { tourId: 't-1', priceUnit: 'per_person', maxParticipants: 10, lodgingIncluded: null } }),
    day(2, 'activity', { title: 'Мутновский вулкан', realPrice: 30000,
      realTour: { tourId: 't-2', priceUnit: 'per_tour', maxParticipants: 4, lodgingIncluded: null } }),
    day(3, 'activity', { title: 'Прогулка у океана' }),
  ],
  priceBreakdown: { activities: [0, 0], accommodation: [0, 0], transport: [0, 0], perPersonTotal: [0, 0] },
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
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
/** Текст без неразрывных пробелов: toLocaleString('ru-RU') делит тысячи U+00A0. */
const text = (el: Element) => (el.textContent ?? '').replace(/\u00a0/g, ' ');

/** Кнопка «Удалить день» в карточке дня с этим заголовком. */
function deleteButtonOf(title: string): HTMLElement {
  for (const btn of screen.getAllByTitle('Удалить день')) {
    let el: HTMLElement | null = btn;
    while (el && !(el.textContent ?? '').includes(title)) el = el.parentElement;
    if (el && (el.textContent ?? '').split('Удалить').length <= 2) return btn;
    if (el && !(el.textContent ?? '').includes('Авачинский вулкан')) return btn;
  }
  throw new Error(`кнопка удаления дня «${title}» не найдена`);
}

async function buildPlan() {
  render(<PlannerClient />);
  // Местный: без дней на самолёт, ночей дома и трансфера аэропорта.
  fireEvent.click(screen.getByRole('radio', { name: /Живу на Камчатке/ }));
  fireEvent.change(screen.getByLabelText('Первый день поездки'), { target: { value: '2030-08-03' } });
  fireEvent.change(screen.getByLabelText('Последний день поездки'), { target: { value: '2030-08-05' } });
  next(); next(); next();
  fireEvent.click(screen.getByRole('button', { name: /Вулканы/ }));
  fireEvent.click(screen.getByRole('button', { name: /Собрать маршрут/ }));
  return screen.findByTestId('price-estimate');
}

describe('смета на группу в /planner', () => {
  it('тур за человека — на каждого, тур за группу — один раз на группу', async () => {
    const estimate = await buildPlan();
    expect(within(estimate).getByText(/Смета на группу · 2 чел\./)).toBeTruthy();
    expect(within(estimate).getByText('10 000 ₽ × 2 чел.')).toBeTruthy();
    expect(within(estimate).getByText('30 000 ₽ за группу')).toBeTruthy();
    // 10 000 × 2 + 30 000 = 50 000; верх вилки тура ×1.2 → 60 000.
    expect(text(estimate)).toContain('Итого на группу50 000 — 60 000 ₽');
    // Ориентиров в этом плане нет — подпись не выдаёт пустую вилку «(0 ₽)».
    expect(text(estimate)).toContain('Все суммы — цены туров от операторов.');
    expect(text(estimate)).not.toContain('(0 ₽)');
  });

  it('карточка дня называет, за что цена тура (шаг 1б)', async () => {
    await buildPlan();
    const tags = screen.getAllByTestId('day-price').map(text);
    expect(tags).toContain('30 000 ₽за группу');
    expect(tags).toContain('10 000 ₽за человека');
    // День без тура и без ориентира — без цены, а не «от 0 ₽».
    expect(tags.some((t) => t.includes('0 ₽на человека'))).toBe(false);
  });

  it('заявка уходит с планом целиком: состав, туры с ценой, смета (шаг 2)', async () => {
    await buildPlan();
    fireEvent.click(screen.getAllByRole('button', { name: /Запросить подробное предложение/ })[0]!);
    fireEvent.change(screen.getByPlaceholderText('Ваше имя'), { target: { value: 'Иван Петров' } });
    fireEvent.change(screen.getByPlaceholderText('+7 900 000-00-00'), { target: { value: '+79991234567' } });
    fireEvent.click(document.getElementById('pd-consent-planner')!);
    fireEvent.click(screen.getByRole('button', { name: 'Отправить заявку' }));
    const call = vi.mocked(fetch).mock.calls.find(([url]) => url === '/api/leads');
    expect(call, 'заявка не ушла').toBeDefined();
    const sd = JSON.parse(String(call![1]!.body)).source_data;
    expect(sd.plan.party).toEqual({ adults: 2, children: [] });
    expect(sd.plan.days[1].tour).toMatchObject({ id: 't-2', price: 30000, unit: 'per_tour' });
    expect(sd.plan.estimate.total).toEqual([50000, 60000]);
    expect(sd.day_plan).toBeUndefined();
  });

  it('удалили день с туром — смета пересчиталась без него', async () => {
    const estimate = await buildPlan();
    fireEvent.click(deleteButtonOf('Мутновский вулкан'));
    expect(screen.queryByText('30 000 ₽ за группу')).toBeNull();
    expect(text(estimate)).toContain('Итого на группу20 000 — 24 000 ₽');
  });
});
