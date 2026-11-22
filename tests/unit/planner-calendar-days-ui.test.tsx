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
  // Выбор транспорта есть только у дня, которому движок разрешил больше
  // одного вида (#3347): экран читает `allowedTransports` дня, а не зону.
  day(4, 'activity', 'Прогулка у океана', { activityType: 'sea', allowedTransports: ['walking', 'jeep'] }),
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
    title: el.querySelector('[data-day-title]')?.textContent ?? '',
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
/**
 * С 14.11 собранный план сам сохраняется в личный кабинет (POST /api/trips,
 * слово владельца «6 хранить в лк»), и правки дней уходят кнопкой «Обновить
 * маршрут» — PATCH той же поездки. Это и есть «сохранить» после правок.
 */
const TRIP_URL = '/api/trips/00000000-0000-4000-8000-000000000001';
async function saveEdits(): Promise<Record<string, unknown>> {
  await vi.waitFor(() => posted('/api/trips'));
  const button = await screen.findByRole('button', { name: /Сохранено|Обновить маршрут/ });
  fireEvent.click(button);
  await vi.waitFor(() => posted(TRIP_URL));
  return posted(TRIP_URL) as Record<string, unknown>;
}
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

    // Ссылка из дня в форму тура — дата дня 3. Тур дня приходит отдельным
    // запросом (tours-for-day) после сборки плана: ссылку ждём, а не ищем
    // сразу — под нагрузкой ответ приходил позже, и тест падал через раз.
    const link = await vi.waitFor(() => within(card('Авачинский вулкан').el).getByTitle('Открыть тур и оставить заявку'));
    expect(link.getAttribute('href')).toContain(`date=${dateOf(3)}`);

    // Смета: ночей пять — по ночи на каждый день, кроме дня отъезда; цену
    // жилья называет хозяин (14.11, «5 -1»).
    expect((estimate.textContent ?? '').replace(/ /g, ' ')).toContain('5 ночей — цену называет хозяин жилья');

    // Сохранить: номера подряд, порядок экрана; у переехавшего тура нет мест прежней даты.
    const trip = await saveEdits() as { days: Array<{ day: number; title: string; availableDate?: string }>; arrivalDate: string; departureDate: string; transportByDay: unknown };
    expect(trip.arrivalDate).toBe(ARRIVAL);
    expect(trip.departureDate).toBe('2030-08-06');
    expect(trip.days.map((d) => `${d.day}:${d.title}`)).toEqual(shown());
    expect(trip.days.find((d) => d.title === 'Авачинский вулкан')).not.toHaveProperty('availableDate');
    expect(trip.transportByDay).toEqual({ 2: 'jeep' });
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
    expect((await saveEdits()).departureDate).toBe('2030-08-05');
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

describe('перестановка: цена тура перечитывается на новую дату (разбор 14.11, смета-5)', () => {
  /** Ответ роута о туре дня держим, пока тест не отпустит. */
  function holdTourDay() {
    const base = vi.mocked(fetch).getMockImplementation()!;
    let release: (body: unknown) => void = () => undefined;
    const answer = new Promise<unknown>((r) => { release = r; });
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes('tour_id=')) return { ok: true, json: async () => answer } as Response;
      return base(url, init);
    });
    return (body: unknown) => act(async () => { release(body); await answer; });
  }
  const priceOf = (title: string) =>
    (within(card(title).el).queryByTestId('day-price')?.textContent ?? '').replace(/[  ]/g, ' ');

  it('тур переехал на другой день — цена прежней даты снята, новая встаёт из ответа', async () => {
    PLAN_DAYS = FULL;
    const estimate = await buildPlan('2030-08-04');
    const release = holdTourDay();
    expect(priceOf('Авачинский вулкан')).toContain('10 000 ₽');

    const v = dnd.values!;
    act(() => dnd.onReorder!([v[0], v[2], v[1], v[3]]));
    act(() => dnd.onDragEnd!());
    expect(shown()).toEqual(['1:Прилёт днём', '2:Прогулка у океана', '3:Авачинский вулкан', '4:Сборы и вылет']);

    // Ответа ещё нет: цены прежней даты на карточке и в смете нет.
    expect(priceOf('Авачинский вулкан')).not.toContain('10 000');
    expect((estimate.textContent ?? '').replace(/[  ]/g, ' ')).not.toContain('10 000');

    // Спросили тур этого дня на его новую дату и всю группу.
    const asked = vi.mocked(fetch).mock.calls.map(([u]) => String(u)).find((u) => u.includes('tour_id='))!;
    const q = new URL(asked, 'http://localhost').searchParams;
    expect(q.get('tour_id')).toBe('t-1');
    expect(q.get('date')).toBe('2030-08-03');
    expect(q.get('participants')).toBe('2');
    expect(q.get('max')).toBe('10');

    await release({ success: true, read: { availability: 'open', availableDate: '2030-08-03', slotsRemaining: 4, realPrice: 11500, priceFrom: 11500, priceTo: 11500, priceLabel: 'сезонная цена' } });
    await vi.waitFor(() => expect(priceOf('Авачинский вулкан')).toContain('11 500 ₽'));
    expect(priceOf('Авачинский вулкан')).toContain('сезонная цена');
  });

  it('роут не ответил данными — цена «проверить не удалось», а не прежняя', async () => {
    PLAN_DAYS = FULL;
    await buildPlan('2030-08-04');
    const release = holdTourDay();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const v = dnd.values!;
    act(() => dnd.onReorder!([v[0], v[2], v[1], v[3]]));
    act(() => dnd.onDragEnd!());
    await release({ success: false, error: 'сбой' });
    await vi.waitFor(() => expect(priceOf('Авачинский вулкан')).toContain('цену называет оператор'));
    expect(priceOf('Авачинский вулкан')).not.toContain('10 000');
    expect(err.mock.calls.some((c) => String(c[0]).includes('цена тура на новую дату не перечитана'))).toBe(true);
    err.mockRestore();
  });
});

describe('экран после сборки: мелкие отказы и лишнее (разбор 14.11, экран-15 и экран-19)', () => {
  const wrapFetch = (over: (u: string) => unknown | undefined) => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const r = over(String(url));
      return r === undefined ? base(url, init) : ({ ok: true, json: async () => r } as Response);
    });
  };

  it('заявка ушла — планер на месте, вместо формы строка «Заявка отправлена»', async () => {
    PLAN_DAYS = FULL;
    await buildPlan('2030-08-04');
    wrapFetch((u) => (u === '/api/leads' ? { success: true } : undefined));
    fireEvent.click(screen.getAllByRole('button', { name: /Запросить подробное предложение/ })[0]!);
    fireEvent.change(screen.getByPlaceholderText('Ваше имя'), { target: { value: 'Тест' } });
    fireEvent.change(screen.getByPlaceholderText('+7 900 000-00-00'), { target: { value: '+70000000000' } });
    fireEvent.click(document.getElementById('pd-consent-planner')!);
    fireEvent.click(screen.getByRole('button', { name: 'Отправить заявку' }));
    await vi.waitFor(() => expect(screen.getAllByText(/Заявка отправлена/).length).toBeGreaterThan(0));
    expect(cards().length).toBe(4);
    // План по-прежнему можно отправить: кнопка «Поделиться» на месте.
    expect(screen.getByTitle('Поделиться маршрутом')).toBeTruthy();
    expect(screen.queryByText('Готово!')).toBeNull();
  });

  it('буфер обмена отказал — сказано, ссылка видна целиком', async () => {
    PLAN_DAYS = FULL;
    await buildPlan('2030-08-04');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    wrapFetch((u) => (/\/api\/trips\/[^/]+\/share$/.test(u) ? { success: true, shareUrl: 'https://vedarai.ru/trip/abc' } : undefined));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => { throw new Error('denied'); }) } });
    fireEvent.click(screen.getByTitle('Поделиться маршрутом'));
    const copy = await screen.findByRole('button', { name: /Копировать ссылку/ });
    await act(async () => { fireEvent.click(copy); });
    expect(screen.getByText(/Не скопировалось/).textContent).toContain('https://vedarai.ru/trip/abc');
    expect(err.mock.calls.some((c) => String(c[0]).includes('ссылка не скопировалась'))).toBe(true);
    err.mockRestore();
  });

  it('тур дня не загрузился — следующая правка плана спрашивает снова, а не считает «тура нет»', async () => {
    PLAN_DAYS = FULL;
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let fail = true;
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const u = String(url);
      if (fail && u.startsWith('/api/planner/tours-for-day') && u.includes('activity_type=sea')) {
        return { ok: false, status: 500, json: async () => ({ success: false, error: 'сбой' }) } as Response;
      }
      return base(url, init);
    });
    await buildPlan('2030-08-04');
    const asked = () => vi.mocked(fetch).mock.calls.filter(([u]) => String(u).includes('activity_type=sea')).length;
    await vi.waitFor(() => expect(asked()).toBe(1));
    fail = false;
    // Правка, которая дату дня с морем не меняет: удалить другой день. Тот
    // же день на ту же дату спрашивается снова — сбой не записан в «тура нет».
    fireEvent.click(within(card('Авачинский вулкан').el).getByTitle('Удалить день'));
    await vi.waitFor(() => expect(asked()).toBe(2));
    err.mockRestore();
  });
});

describe('житель края: рейсов нет (разбор 14.11, экран-19)', () => {
  it('«Номера рейсов» не показываются, введённое раньше не уходит в заявку', async () => {
    render(<PlannerClient initialUserId="u-1" />);
    fireEvent.change(screen.getByLabelText('Время прилёта'), { target: { value: '10:30' } });
    expect(screen.getByText('Номера рейсов')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Рейс прилёта'), { target: { value: 'su1700' } });
    fireEvent.click(screen.getByRole('radio', { name: /Живу на Камчатке/ }));
    expect(screen.queryByText('Номера рейсов')).toBeNull();
    // Обратно приезжим: поля пустые — прежний рейс сброшен, а не спрятан.
    fireEvent.click(screen.getByRole('radio', { name: /Прилетаю|Приезжаю|Приезж|Гость/ }));
    expect((screen.getByLabelText('Рейс прилёта') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Время прилёта') as HTMLInputElement).value).toBe('');
  });
});

describe('отметка дня — не подтверждение (разбор 14.11, экран-13)', () => {
  it('слова отметки не обещают ни брони, ни готового маршрута', async () => {
    PLAN_DAYS = FULL;
    await buildPlan('2030-08-04');
    expect(screen.queryByText(/Подтвердить день|День подтверждён|Маршрут готов/)).toBeNull();
    const first = card('Авачинский вулкан');
    fireEvent.click(within(first.el).getByTitle('Подробнее'));
    fireEvent.click(within(first.el).getByRole('button', { name: /Отметить день как просмотренный/ }));
    expect(within(first.el).getByText('Отмечен вами — это не бронь')).toBeTruthy();
    expect(screen.queryByText(/Маршрут готов/)).toBeNull();
  });
});

describe('две сборки подряд: на экране — последняя (разбор 14.11, экран-15)', () => {
  it('ответ первой сборки, пришедший позже, не ложится поверх второй', async () => {
    const base = vi.mocked(fetch).getMockImplementation()!;
    let releaseFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>((r) => { releaseFirst = r; });
    let calls = 0;
    const answer = (days: unknown[]) => ({ success: true, data: { zones: [], warnings: [], itinerary: '', days,
      priceBreakdown: { activities: [0, 0], accommodation: [0, 0], transport: [0, 0], perPersonTotal: [0, 0] } } });
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.startsWith('/api/planner/recommend')) {
        calls += 1;
        if (calls === 1) { await firstHeld; return { ok: true, json: async () => answer(GAPPED) } as Response; }
        return { ok: true, json: async () => answer(FULL) } as Response;
      }
      if (u === '/api/planner/chat') {
        return { ok: true, json: async () => ({ success: true, places: ['volcano'], activities: [], arrival: ARRIVAL, departure: '2030-08-04', auto_recommend: true }) } as Response;
      }
      return base(url, init);
    });
    render(<PlannerClient initialUserId="u-1" />);
    fireEvent.change(screen.getByLabelText('Дата прилёта'), { target: { value: ARRIVAL } });
    fireEvent.change(screen.getByLabelText('Дата отъезда'), { target: { value: '2030-08-06' } });
    next(); next(); next();
    fireEvent.click(screen.getByRole('button', { name: /Вулканы/ }));
    fireEvent.click(screen.getByRole('button', { name: /Собрать маршрут/ }));
    // Первая сборка висит. Назад к фразе — вторая сборка.
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: /Назад/ }));
    fireEvent.change(screen.getByLabelText(/Опишите поездку одной фразой/), { target: { value: 'вулканы 1-4 августа' } });
    fireEvent.keyDown(screen.getByLabelText(/Опишите поездку одной фразой/), { key: 'Enter' });
    await screen.findByTestId('price-estimate');
    await vi.waitFor(() => expect(shown()).toEqual(['1:Прилёт днём', '2:Авачинский вулкан', '3:Прогулка у океана', '4:Сборы и вылет']));
    await act(async () => { releaseFirst(); await new Promise((r) => setTimeout(r, 20)); });
    expect(shown()).toEqual(['1:Прилёт днём', '2:Авачинский вулкан', '3:Прогулка у океана', '4:Сборы и вылет']);
    expect(calls).toBe(2);
  });
});
