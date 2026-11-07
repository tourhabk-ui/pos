/**
 * Сквозная приёмка волны 2.1–2.2 аудита планировщика (07.11): собрать план →
 * удалить день 3 → переставить → сохранить. У каждого дня одна дата везде:
 * номер на карточке, ссылка в форму тура, смета (ночи), заявка оператору,
 * сохранение, GPX и страница по ссылке. Правила — lib/planner/calendar-days,
 * их граничные случаи — tests/unit/planner-calendar-days.test.ts.
 *
 * Перетаскивание в jsdom не воспроизводится (раскладка нулевая), поэтому
 * Reorder подменён прослойкой: она отдаёт тесту onReorder группы и onDragEnd
 * карточки — те самые обработчики, которые зовёт framer-motion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import React from 'react';
import { NextRequest } from 'next/server';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/planner',
}));
vi.mock('next/dynamic', () => ({ default: () => function DynamicStub() { return null; } }));
vi.mock('@/hooks/useMyReferralCode', () => ({ useMyReferralCode: () => null }));
vi.mock('@/lib/funnel/beacon', () => ({ funnelBeacon: vi.fn() }));

const dnd: { values?: unknown[]; onReorder?: (v: unknown[]) => void; onDragEnd?: () => void } = {};
vi.mock('framer-motion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('framer-motion')>();
  const { createElement } = await import('react');
  type Props = { children?: React.ReactNode; className?: string };
  return {
    ...actual,
    useDragControls: () => ({ start: () => undefined }),
    Reorder: {
      Group: ({ values, onReorder, children, className }: Props & { values: unknown[]; onReorder: (v: unknown[]) => void }) => {
        dnd.values = values;
        dnd.onReorder = onReorder;
        return createElement('ul', { className, 'data-testid': 'day-list' }, children);
      },
      Item: ({ onDragEnd, children, className }: Props & { onDragEnd?: () => void }) => {
        dnd.onDragEnd = onDragEnd;
        return createElement('li', { className, 'data-testid': 'day-card' }, children);
      },
    },
  };
});

// Сохранённая поездка для GPX и страницы по ссылке — то, что ушло в /api/trips.
const saved: { days: unknown[] } = { days: [] };
const ARRIVAL = '2030-08-01';
vi.mock('@/lib/auth/middleware', () => ({ requireAuth: vi.fn(async () => ({ userId: 'u-1' })) }));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: vi.fn(async () => ({ rows: [{ title: 'Маршрут', arrival_date: ARRIVAL, days: saved.days }] })) },
}));
vi.mock('@/lib/trips/shared-plan', () => ({
  readSharedPlan: vi.fn(async () => ({
    kind: 'found',
    plan: {
      source: 'trip', id: 'trip-1', title: 'Маршрут', arrival_date: ARRIVAL, departure_date: '2030-08-06',
      places: [], activities: [], days: saved.days, transport_by_day: {},
    },
  })),
}));
vi.mock('@/lib/tours/top-tour-by-activity', () => ({
  topToursByActivity: vi.fn(async (acts: string[]) => Object.fromEntries(acts.map((a) => [a, {
    id: `top-${a}`, slug: null, title: `Тур ${a}`, base_price: '1000', operator_name: 'Оператор',
    operator_slug: null, operator_public: null, weather_dependent: false,
  }]))),
  toursByIds: vi.fn(async () => ({})),
}));
vi.mock('@/lib/seat-requests/service', () => ({ tourKeepsSchedule: vi.fn(async () => true) }));
vi.mock('@/lib/planner', () => ({
  createPlannerCache: () => new Map(),
  fetchAvailabilityForTour: vi.fn(async (_id: string, from: string) => [{ date: from, remaining: 3 }]),
  fetchForecastDays: vi.fn(async () => ({ ok: false })),
  fetchContingencyAlternatives: vi.fn(async () => []),
}));

import { PlannerClient } from '@/app/planner/_PlannerClient';
import { GET as gpxGET } from '@/app/api/trips/[id]/gpx/route';
import { GET as shareGET } from '@/app/api/trips/share/[token]/route';

const day = (n: number, type: string, title: string, extra: Record<string, unknown> = {}) => ({
  day: n, type, zone: 'avachinsky', title, description: '', activityType: type === 'activity' ? 'volcano' : type,
  priceFrom: 0, priceTo: 0, coords: [53.2, 158.6 + n / 100], defaultTransport: 'walking', allowedTransports: ['walking'],
  difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: [], ...extra,
});
const tour = (id: string) => ({ tourId: id, priceUnit: 'per_person', maxParticipants: 10, lodgingIncluded: false, operatorName: 'Оператор' });

// Прилёт 01.08, отъезд 06.08 — шесть дней. Пятый день движок не наполнил
// («наполнили 4 из 6»): день отъезда у него с номером-датой 6, в номерах дыра.
const GAPPED = [
  day(1, 'arrival', 'Прилёт днём'),
  day(2, 'activity', 'Авачинский вулкан', { realTour: tour('t-1'), realPrice: 10000, availableDate: '2030-08-02', slotsRemaining: 6 }),
  day(3, 'activity', 'Мутновский вулкан', { realTour: tour('t-2'), realPrice: 12000, availableDate: '2030-08-03' }),
  day(4, 'activity', 'Прогулка у океана', { activityType: 'sea' }),
  day(6, 'departure', 'Сборы и вылет'),
];
// Без дыр: прилёт 01.08, отъезд 04.08.
const FULL = [
  day(1, 'arrival', 'Прилёт днём'),
  day(2, 'activity', 'Авачинский вулкан', { realTour: tour('t-1'), realPrice: 10000 }),
  day(3, 'activity', 'Прогулка у океана', { activityType: 'sea' }),
  day(4, 'departure', 'Сборы и вылет'),
];
let PLAN_DAYS: unknown[] = GAPPED;

beforeEach(() => {
  PLAN_DAYS = GAPPED;
  saved.days = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const json = u.startsWith('/api/planner/recommend')
      ? { success: true, data: { zones: [], warnings: [], itinerary: '', days: PLAN_DAYS,
        priceBreakdown: { activities: [0, 0], accommodation: [0, 0], transport: [0, 0], perPersonTotal: [0, 0] } } }
      : u.startsWith('/api/planner/tours-for-day') && u.includes('activity_type=volcano')
        ? { success: true, tours: [{ id: '101', slug: 'avachinsky-voshozhdenie', title: 'Восхождение', base_price: '10000', price_unit: 'per_person', operator_slug: 'op' }] }
        : u === '/api/trips'
          ? { success: true, data: { id: '00000000-0000-4000-8000-000000000001' } }
          : { success: true, data: [], tours: [] };
    return { ok: true, json: async () => json } as Response;
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const next = () => fireEvent.click(screen.getByRole('button', { name: /Дальше/ }));

async function buildPlan(departure: string) {
  render(<PlannerClient initialUserId="u-1" />);
  fireEvent.change(screen.getByLabelText('Дата прилёта'), { target: { value: ARRIVAL } });
  fireEvent.change(screen.getByLabelText('Дата отъезда'), { target: { value: departure } });
  next(); next(); next();
  fireEvent.click(screen.getByRole('button', { name: /Вулканы/ }));
  fireEvent.click(screen.getByRole('button', { name: /Собрать маршрут/ }));
  return screen.findByTestId('price-estimate');
}

/** Карточки дней в порядке экрана: номер в кружке и название. */
function cards() {
  return [...document.querySelectorAll<HTMLElement>('[data-testid="day-card"]')].map((el) => ({
    el,
    num: Number(el.querySelector('.rounded-full.w-6')?.textContent),
    title: el.querySelector('p.text-xs.font-medium')?.textContent ?? '',
  }));
}
const shown = () => cards().map((c) => `${c.num}:${c.title}`);
const card = (title: string) => {
  const c = cards().find((x) => x.title === title);
  if (!c) throw new Error(`карточки «${title}» нет: ${shown().join(', ')}`);
  return c;
};
const posted = (url: string) => {
  const call = vi.mocked(fetch).mock.calls.filter(([u]) => u === url).at(-1);
  if (!call) throw new Error(`запроса ${url} не было`);
  return JSON.parse(String(call[1]!.body));
};
const dateOf = (n: number) => new Date(Date.parse(`${ARRIVAL}T00:00:00Z`) + (n - 1) * 86_400_000).toISOString().slice(0, 10);

describe('собрать → удалить день 3 → переставить → сохранить: одна дата у дня везде', () => {
  it('сквозная приёмка', async () => {
    const estimate = await buildPlan('2030-08-06');

    // Дыра движка — свободный день, отъезд остаётся днём 6 (06.08), а не 5.
    expect(shown()).toEqual([
      '1:Прилёт днём', '2:Авачинский вулкан', '3:Мутновский вулкан', '4:Прогулка у океана', '5:Свободный день', '6:Сборы и вылет',
    ]);

    // Удалить день 3: он становится свободным, поездка не короче.
    fireEvent.click(within(card('Мутновский вулкан').el).getByTitle('Удалить день'));
    expect(shown()).toEqual([
      '1:Прилёт днём', '2:Авачинский вулкан', '3:Свободный день', '4:Прогулка у океана', '5:Свободный день', '6:Сборы и вылет',
    ]);
    // У свободного дня убирать нечего.
    expect(within(cards()[2]!.el).queryByTitle('Удалить день')).toBeNull();

    // Транспорт дня выбран на прогулке (день 4) — он уйдёт вслед за ней.
    fireEvent.click(within(card('Прогулка у океана').el).getByTitle(/^Джип/));

    // Переставить: прогулку — на второй день. Пока карточку держат, номера
    // прежние; отпустили — встают по местам.
    const v = dnd.values!;
    act(() => dnd.onReorder!([v[0], v[3], v[1], v[2], v[4], v[5]]));
    act(() => dnd.onDragEnd!());
    expect(shown()).toEqual([
      '1:Прилёт днём', '2:Прогулка у океана', '3:Авачинский вулкан', '4:Свободный день', '5:Свободный день', '6:Сборы и вылет',
    ]);

    // Ссылка из дня в форму тура — дата дня 3.
    const link = within(card('Авачинский вулкан').el).getByTitle('Открыть тур и оставить заявку');
    expect(link.getAttribute('href')).toContain(`date=${dateOf(3)}`);

    // Смета: ночей пять — по ночи на каждый день, кроме дня отъезда.
    expect((estimate.textContent ?? '').replace(/ /g, ' ')).toContain('5 ночей × 2 чел.');

    // Сохранить: номера подряд, порядок экрана; у переехавшего тура нет мест прежней даты.
    fireEvent.click(screen.getByRole('button', { name: /Сохранить/ }));
    await vi.waitFor(() => posted('/api/trips'));
    const trip = posted('/api/trips') as { days: Array<{ day: number; title: string; availableDate?: string }>; arrivalDate: string; departureDate: string };
    expect(trip.arrivalDate).toBe(ARRIVAL);
    expect(trip.departureDate).toBe('2030-08-06');
    expect(trip.days.map((d) => `${d.day}:${d.title}`)).toEqual(shown());
    expect(trip.days.find((d) => d.title === 'Авачинский вулкан')).not.toHaveProperty('availableDate');
    expect(posted('/api/trips').transportByDay).toEqual({ 2: 'jeep' });
    saved.days = trip.days;

    // Заявка оператору: дни календарные, дата дня — прилёт + номер − 1.
    fireEvent.click(screen.getAllByRole('button', { name: /Запросить подробное предложение/ })[0]!);
    fireEvent.change(screen.getByPlaceholderText('Ваше имя'), { target: { value: 'Тест' } });
    fireEvent.change(screen.getByPlaceholderText('+7 900 000-00-00'), { target: { value: '+79990000000' } });
    fireEvent.click(document.getElementById('pd-consent-planner')!);
    fireEvent.click(screen.getByRole('button', { name: 'Отправить заявку' }));
    const lead = posted('/api/leads').source_data as {
      trip_days: number; transport_choices: Record<string, string>;
      plan: { days: Array<{ day: number; date: string; title: string; tour?: { id: string; available_date?: string } }> };
    };
    expect(lead.trip_days).toBe(6);
    expect(lead.transport_choices).toEqual({ 2: 'jeep' });
    expect(lead.plan.days.map((d) => `${d.day}:${d.title}`)).toEqual(shown());
    for (const d of lead.plan.days) expect(d.date, d.title).toBe(dateOf(d.day));
    const volcanoInLead = lead.plan.days.find((d) => d.title === 'Авачинский вулкан')!;
    expect(volcanoInLead.date).toBe('2030-08-03');
    expect(volcanoInLead.tour).toMatchObject({ id: 't-1' });
    expect(volcanoInLead.tour).not.toHaveProperty('available_date');

    // GPX сохранённой поездки: «День N: …» с той же датой.
    const gpx = await (await gpxGET(new NextRequest('http://localhost/api/trips/00000000-0000-4000-8000-000000000001/gpx'),
      { params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000001' }) })).text();
    const points = [...gpx.matchAll(/<wpt [^>]*>\s*<name>День (\d+): ([^<]+)<\/name>\s*<desc>([^<]+)<\/desc>/g)]
      .map((m) => ({ num: Number(m[1]), title: m[2], date: m[3] }));
    expect(points.map((p) => `${p.num}:${p.title}`)).toEqual(shown());
    expect(points.find((p) => p.title === 'Авачинский вулкан')?.date).toBe('2030-08-03');
    for (const p of points) expect(p.date, p.title).toBe(dateOf(p.num));

    // Страница по ссылке: места тура дня считаются на ту же дату.
    const share = await (await shareGET(new NextRequest('http://localhost/api/trips/share/00000000-0000-4000-8000-000000000002'),
      { params: Promise.resolve({ token: '00000000-0000-4000-8000-000000000002' }) })).json() as {
      data: { availability: Record<string, { date: string }> };
    };
    expect(share.data.availability['3']?.date).toBe('2030-08-03');
    expect(share.data.availability['2']?.date).toBe('2030-08-02');
  });
});

describe('добавить день', () => {
  it('свободный день есть — открывается он, поездка не длиннее', async () => {
    await buildPlan('2030-08-06');
    fireEvent.click(screen.getByRole('button', { name: /Добавить день/ }));
    expect(cards()).toHaveLength(6);
    expect(screen.getAllByText(/Замена дня 5|День 5/).length).toBeGreaterThan(0);
  });

  it('свободных нет — поездка на день длиннее, отъезд на день позже, и это сказано', async () => {
    PLAN_DAYS = FULL;
    await buildPlan('2030-08-04');
    fireEvent.click(screen.getByRole('button', { name: /Добавить день/ }));
    expect(shown()).toEqual(['1:Прилёт днём', '2:Авачинский вулкан', '3:Прогулка у океана', '4:Свободный день', '5:Сборы и вылет']);
    expect(screen.getByText(/Поездка стала на день длиннее: новый день 4, отъезд — 5 авг/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Сохранить/ }));
    await vi.waitFor(() => posted('/api/trips'));
    expect(posted('/api/trips').departureDate).toBe('2030-08-05');
  });
});

describe('форма: дни по календарю (H3), однодневная поездка местного (H4)', () => {
  it('10→14 — пять дней и четыре ночи', () => {
    render(<PlannerClient />);
    fireEvent.change(screen.getByLabelText('Дата прилёта'), { target: { value: '2030-07-10' } });
    fireEvent.change(screen.getByLabelText('Дата отъезда'), { target: { value: '2030-07-14' } });
    expect(screen.getByText('5 дней (4 ночи) на Камчатке')).toBeTruthy();
  });

  it('местный: выехал и вернулся в один день — форма пускает дальше', () => {
    render(<PlannerClient />);
    fireEvent.click(screen.getByRole('radio', { name: /Живу на Камчатке/ }));
    fireEvent.change(screen.getByLabelText('Первый день поездки'), { target: { value: '2030-08-03' } });
    fireEvent.change(screen.getByLabelText('Последний день поездки'), { target: { value: '2030-08-03' } });
    expect(screen.getByText('1 день, без ночёвки на Камчатке')).toBeTruthy();
    next();
    expect(screen.queryByText(/должна быть позже|не может быть раньше/)).toBeNull();
  });

  it('прилетающий: прилёт и отъезд в один день — не поездка, сказано почему', () => {
    render(<PlannerClient />);
    fireEvent.change(screen.getByLabelText('Дата прилёта'), { target: { value: '2030-08-03' } });
    fireEvent.change(screen.getByLabelText('Дата отъезда'), { target: { value: '2030-08-03' } });
    next();
    expect(screen.getByText('Дата отъезда должна быть позже даты прилёта.')).toBeTruthy();
  });
});
