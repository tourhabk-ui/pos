/**
 * Сторож экрана: что карта планировщика говорит человеку (владелец 22.10:
 * «как работает карта в Планировщике не пойму?» → «карта да»).
 *
 * Рендером, на настоящем PlannerClient (карта Leaflet подменена заглушкой,
 * которая запоминает, ЧТО ей отдали рисовать) и на самой плашке карты:
 *   — отказ каталога — «Маршруты не загрузились…» и «Повторить», который
 *     спрашивает снова; не молчание и не «маршрутов нет»;
 *   — каталог ответил пусто — так и сказано;
 *   — легенда называет зоны словами, и кружок у зоны — того же цвета, что
 *     пины её точек, отданные карте;
 *   — дни плана уходят на карту кружками с номерами;
 *   — подсказка говорит, что делать с точкой; прежней плашки
 *     «N маршрутов по зонам» с четырьмя кружками-токенами нет.
 *
 * Второй круг ревью 22.10:
 *   — прилёт и отъезд в одной точке — один пин «1·3», нажатия открывают
 *     оба дня по очереди;
 *   — день, который маршрутом не заменяют, не обещает «нажмите точку»,
 *     и карточка маршрута не предлагает «Заменить»;
 *   — поздний ответ прежнего запроса не затирает свежий; после «Повторить»
 *     — «Загружаем», а не прежний отказ;
 *   — день из маршрута без зоны подписан «Зона не записана», а не догадкой.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
import React from 'react';
import type { MapMarker } from '@/components/shared/leaflet-types';

const captured = vi.hoisted(() => ({
  markers: [] as unknown[],
  onMarkerClick: null as ((id: string) => void) | null,
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/planner',
}));
vi.mock('next/dynamic', () => ({
  default: () => function LeafletStub(props: { markers?: unknown[]; onMarkerClick?: (id: string) => void }) {
    captured.markers = props.markers ?? [];
    captured.onMarkerClick = props.onMarkerClick ?? null;
    return null;
  },
}));
vi.mock('@/hooks/useMyReferralCode', () => ({ useMyReferralCode: () => null }));
vi.mock('@/lib/funnel/beacon', () => ({ funnelBeacon: vi.fn() }));

import { PlannerClient } from '@/app/planner/_PlannerClient';
import { PlannerMapOverlay, MAP_TEXT } from '@/components/planner/PlannerMapOverlay';
import { resolveMarkerColor } from '@/lib/map/marker-colors';
import { plannerLegend } from '@/lib/planner/map-markers';

/** Каталог: по маршруту в каждой из четырёх зон и один без зоны. */
const CATALOG = [
  { id: 'r1', title: 'Вулкан Авачинский', description: '', lat: 53.25, lng: 158.83, activityType: 'trekking', locationType: 'volcano', zone: 'avachinsky' },
  { id: 'r2', title: 'Курильское озеро', description: '', lat: 51.45, lng: 157.1, activityType: 'trekking', locationType: 'lake', zone: 'western' },
  { id: 'r3', title: 'Долина гейзеров', description: '', lat: 54.43, lng: 160.14, activityType: 'trekking', locationType: 'geyser', zone: 'eastern' },
  { id: 'r4', title: 'Вулкан Толбачик', description: '', lat: 55.83, lng: 160.33, activityType: 'trekking', locationType: 'volcano', zone: 'northern' },
  { id: 'r5', title: 'Маршрут без зоны', description: '', lat: 53.1, lng: 158.4, activityType: 'trekking', locationType: null, zone: null },
];

const day = (n: number, zone: string, title: string, coords: [number, number]) => ({
  day: n, type: 'activity', zone, title, description: '', activityType: 'volcano',
  priceFrom: 0, priceTo: 0, coords, defaultTransport: 'walking', allowedTransports: ['walking'],
  difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: [],
});

const PRICES = { activities: [0, 0], accommodation: [0, 0], transport: [0, 0], perPersonTotal: [0, 0] };

const RECOMMENDATION = {
  zones: [], warnings: [], itinerary: '',
  days: [
    day(1, 'avachinsky', 'Авачинский вулкан', [53.25, 158.83]),
    day(2, 'western', 'Курильское озеро', [51.45, 157.1]),
  ],
  priceBreakdown: PRICES,
};

/** Как собирает движок: прилёт и отъезд — в одной точке Петропавловска (engine.ts, PKC_COORDS). */
const PKC: [number, number] = [53.01, 158.65];
const FRAMED = {
  zones: [], warnings: [], itinerary: '',
  days: [
    { ...day(1, 'avachinsky', 'Прилёт', PKC), type: 'arrival' },
    day(2, 'western', 'Курильское озеро', [51.45, 157.1]),
    { ...day(3, 'avachinsky', 'Вылет', PKC), type: 'departure' },
  ],
  priceBreakdown: PRICES,
};

type RoutesReply = 'data' | 'empty' | 'fail';
let routesReply: RoutesReply = 'data';
let routesData: unknown[] = CATALOG;
let routesCalls = 0;
let recommendation: unknown = RECOMMENDATION;
/** Пока true — ответы каталога ждут release(data): «медленная связь». */
let holdRoutes = false;
let held: Array<(data: unknown[]) => void> = [];

const okRoutes = (data: unknown[]) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) } as Response);

beforeEach(() => {
  routesReply = 'data';
  routesData = CATALOG;
  routesCalls = 0;
  recommendation = RECOMMENDATION;
  holdRoutes = false;
  held = [];
  captured.markers = [];
  captured.onMarkerClick = null;
  Element.prototype.scrollIntoView = vi.fn();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.startsWith('/api/routes')) {
      routesCalls += 1;
      if (holdRoutes) return new Promise<Response>(res => { held.push(data => res(okRoutes(data))); });
      if (routesReply === 'fail') return { ok: false, status: 503, json: async () => ({ success: false }) } as Response;
      return okRoutes(routesReply === 'data' ? routesData : []);
    }
    const json = u.startsWith('/api/planner/recommend')
      ? { success: true, data: recommendation }
      : { success: true, data: [], tours: [] };
    return { ok: true, status: 200, json: async () => json } as Response;
  }));
});

/** Анкета до четвёртого шага: даты и «Дальше». */
function toInterests() {
  fireEvent.change(screen.getByLabelText('Дата прилёта'), { target: { value: '2030-08-03' } });
  fireEvent.change(screen.getByLabelText('Дата отъезда'), { target: { value: '2030-08-12' } });
  for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: /Дальше/ }));
}

/** Собрать план: интерес «Вулканы» и «Собрать маршрут». */
async function buildPlan() {
  toInterests();
  fireEvent.click(screen.getByRole('button', { name: /Вулканы/ }));
  fireEvent.click(screen.getByRole('button', { name: /Собрать маршрут/ }));
  await screen.findByText(MAP_TEXT.days);
}

const tap = (id: string) => act(() => { captured.onMarkerClick?.(id); });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** «#C2410C» → «rgb(194, 65, 12)» — так jsdom отдаёт цвет из style. */
function rgb(hex: string): string {
  const h = hex.replace('#', '');
  return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`;
}

const markers = () => captured.markers as MapMarker[];

describe('на настоящем экране планировщика', () => {
  it('отказ каталога — сказано словами, «Повторить» спрашивает снова', async () => {
    routesReply = 'fail';
    render(<PlannerClient />);
    const alert = await screen.findByText(MAP_TEXT.failed);
    expect(alert.closest('[role="alert"]')).toBeTruthy();
    expect(screen.queryByText(MAP_TEXT.empty)).toBeNull();
    const before = routesCalls;
    routesReply = 'data';
    fireEvent.click(screen.getByRole('button', { name: MAP_TEXT.retry }));
    await waitFor(() => expect(routesCalls).toBeGreaterThan(before));
    await screen.findByText(new RegExp(`${MAP_TEXT.legendTitle} · 5`));
    expect(screen.queryByText(MAP_TEXT.failed)).toBeNull();
  });

  it('каталог ответил пусто — «маршрутов нет», а не отказ и не молчание', async () => {
    routesReply = 'empty';
    render(<PlannerClient />);
    await screen.findByText(MAP_TEXT.empty);
    expect(screen.queryByText(MAP_TEXT.failed)).toBeNull();
  });

  it('легенда — зоны словами, кружок того же цвета, что пины этих точек на карте', async () => {
    render(<PlannerClient />);
    const list = await screen.findByRole('list', { name: 'Цвета зон на карте' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map(li => li.textContent)).toEqual([
      'Авачинская1', 'Западная1', 'Восточная1', 'Северная1', 'Зона не записана1',
    ]);
    const byZone = new Map(CATALOG.map(r => [r.id, r.zone]));
    const legend = plannerLegend(CATALOG.map(r => ({ id: r.id, title: r.title, lat: r.lat, lng: r.lng, zone: r.zone })));
    for (const [i, entry] of legend.entries()) {
      const swatch = items[i].querySelector('span[aria-hidden]') as HTMLElement;
      expect(swatch.style.background, entry.name).toBe(rgb(entry.hex));
      // Каждая точка этой зоны, отданная карте, рисуется тем же hex.
      const dots = markers().filter(m => byZone.has(m.id ?? '') && (byZone.get(m.id ?? '') ?? null) === entry.zone);
      expect(dots.length, entry.name).toBeGreaterThan(0);
      for (const m of dots) expect(resolveMarkerColor(m.color, 'blue'), m.id).toBe(entry.hex);
    }
  });

  it('подсказка говорит, что делать с точкой; прежней плашки с кружками-токенами нет', async () => {
    const { container } = render(<PlannerClient />);
    await screen.findByText(MAP_TEXT.hintNoPlan);
    expect(container.textContent).not.toMatch(/маршрутов по зонам/);
    expect(container.innerHTML).not.toMatch(/background: var\(--(accent|ocean|success|purple)\)/);
  });

  it('дни плана уходят на карту кружками с номерами, и легенда называет их', async () => {
    render(<PlannerClient />);
    await buildPlan();
    const days = markers().filter(m => m.id?.startsWith('day_'));
    expect(days.map(m => m.label)).toEqual(['1', '2']);
    const dotColors = new Set(markers().filter(m => !m.id?.startsWith('day_') && !m.geometry).map(m => m.color));
    for (const d of days) expect(dotColors.has(d.color)).toBe(false);
    // План появился — на телефоне легенда свернулась до заголовка и строки
    // о днях (развёрнутая закрывала север края); развернуть — одно нажатие.
    const toggle = screen.getByRole('button', { name: new RegExp(MAP_TEXT.legendTitle) });
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'));
    expect(screen.queryByText(MAP_TEXT.hintPlan)).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText(MAP_TEXT.hintPlan)).toBeTruthy();
  });

  it('прилёт и отъезд в одной точке — один пин «1·3»; нажатия открывают оба дня по очереди', async () => {
    recommendation = FRAMED;
    render(<PlannerClient />);
    await buildPlan();
    const pins = markers().filter(m => m.label);
    expect(pins.map(m => m.label)).toEqual(['1·3', '2']);
    const both = pins[0].id ?? '';

    tap(both);
    expect(await screen.findByText('Это день прилёта — его не заменяют маршрутом.')).toBeTruthy();
    expect(screen.getAllByText(/День 1: Прилёт/).length).toBeGreaterThan(0);
    tap(both);
    expect(await screen.findByText('Это день отъезда — его не заменяют маршрутом.')).toBeTruthy();
    tap(both);
    await waitFor(() => expect(screen.queryByText(/его не заменяют маршрутом/)).toBeNull());
  });

  it('день прилёта открыт — ни «нажмите точку», ни «Заменить»; обычный день — оба', async () => {
    recommendation = FRAMED;
    render(<PlannerClient />);
    await buildPlan();
    const both = markers().find(m => m.label === '1·3')?.id ?? '';

    tap(both);
    await screen.findByText('Это день прилёта — его не заменяют маршрутом.');
    expect(screen.queryByText(MAP_TEXT.editAction)).toBeNull();
    tap('r1');
    await screen.findByRole('button', { name: /Добавить в план/ });
    expect(screen.queryByRole('button', { name: /Заменить/ })).toBeNull();

    tap('day_2');
    await screen.findByText(MAP_TEXT.editAction);
    tap('r1');
    expect(await screen.findByRole('button', { name: 'Заменить День 2' })).toBeTruthy();
  });

  it('без открытого дня «Заменить» предлагает только те дни, где замена сработает', async () => {
    recommendation = FRAMED;
    render(<PlannerClient />);
    await buildPlan();
    tap('r1');
    const select = await screen.findByRole('combobox', { name: 'Какой день заменить' });
    expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['День 2: Курильское озеро']);
  });

  it('день из маршрута без зоны — «Зона не записана», а не угаданная зона', async () => {
    render(<PlannerClient />);
    await buildPlan();
    tap('r5');
    fireEvent.click(await screen.findByRole('button', { name: /Добавить в план/ }));
    const card = (await screen.findByText('Маршрут без зоны')).closest('li') as HTMLElement;
    expect(within(card).getByText(/Зона не записана/)).toBeTruthy();
    expect(card.textContent).not.toMatch(/Авачинская зона/);
  });

  it('поздний ответ прежнего запроса не затирает свежий', async () => {
    holdRoutes = true;
    render(<PlannerClient />);
    // Запросы по интересам по умолчанию ушли и висят.
    await waitFor(() => expect(held.length).toBeGreaterThan(0));
    const stale = held;
    held = [];
    holdRoutes = false;
    routesData = [CATALOG[0]];
    toInterests();
    fireEvent.click(screen.getByRole('button', { name: /Вулканы/ }));
    await screen.findByText(new RegExp(`${MAP_TEXT.legendTitle} · 1$`));
    // Прежние ответы приходят позже — с полным каталогом.
    await act(async () => { for (const r of stale) r(CATALOG); });
    expect(screen.getByText(new RegExp(`${MAP_TEXT.legendTitle} · 1$`))).toBeTruthy();
    expect(screen.queryByText(new RegExp(`${MAP_TEXT.legendTitle} · 5$`))).toBeNull();
  });

  it('после «Повторить» — «Загружаем», а не прежний отказ', async () => {
    routesReply = 'fail';
    render(<PlannerClient />);
    await screen.findByText(MAP_TEXT.failed);
    holdRoutes = true;
    fireEvent.click(screen.getByRole('button', { name: MAP_TEXT.retry }));
    expect(await screen.findByText(MAP_TEXT.loading)).toBeTruthy();
    expect(screen.queryByText(MAP_TEXT.failed)).toBeNull();
  });
});

describe('плашка карты сама по себе', () => {
  const base = {
    legend: [], total: 0, partial: false, hasPlan: false, editing: null,
    onRetry: () => {}, onStopEditing: () => {},
  };
  const editingDay = (over: Partial<{ number: number; title: string; refusal: string | null; sameZone: number }> = {}) =>
    ({ number: 2, title: 'Курильское озеро', refusal: null, sameZone: 3, ...over });

  it('загрузка — словами', () => {
    render(<PlannerMapOverlay {...base} status="loading" />);
    expect(screen.getByRole('status').textContent).toContain(MAP_TEXT.loading);
  });

  it('замена дня — что нажать и что значат яркие и серые', () => {
    const stop = vi.fn();
    render(<PlannerMapOverlay {...base} status="ok" total={3}
      legend={[{ zone: 'avachinsky', name: 'Авачинская', hex: '#C2410C', count: 3 }]}
      editing={editingDay()} onStopEditing={stop} />);
    expect(screen.getByText('Замена дня 2: Курильское озеро')).toBeTruthy();
    expect(screen.getByText(MAP_TEXT.editAction)).toBeTruthy();
    expect(screen.getByText(MAP_TEXT.editColors)).toBeTruthy();
    // Легенда при замене не спорит с плашкой замены.
    expect(screen.queryByRole('list', { name: 'Цвета зон на карте' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Закончить замену дня' }));
    expect(stop).toHaveBeenCalled();
  });

  it('замена дня, а точек нет — плашка замены говорит почему, а не «нажмите точку»', () => {
    render(<PlannerMapOverlay {...base} status="empty" hasPlan editing={editingDay({ number: 1, title: 'Мутновский' })} />);
    expect(screen.getByText(MAP_TEXT.empty)).toBeTruthy();
    expect(screen.queryByText(MAP_TEXT.editAction)).toBeNull();
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('легенду можно свернуть — на телефоне она закрывает север края', () => {
    render(<PlannerMapOverlay {...base} status="ok" total={2}
      legend={[{ zone: 'northern', name: 'Северная', hex: '#15803D', count: 2 }]} />);
    const toggle = screen.getByRole('button', { name: /Маршруты по зонам · 2/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(MAP_TEXT.hintNoPlan)).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('list', { name: 'Цвета зон на карте' })).toBeNull();
    expect(screen.queryByText(MAP_TEXT.hintNoPlan)).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole('list', { name: 'Цвета зон на карте' })).toBeTruthy();
  });

  it('часть интересов не загрузилась — с «Повторить», и свёрнутая легенда это не прячет', () => {
    const retry = vi.fn();
    render(<PlannerMapOverlay {...base} status="ok" total={1} partial onRetry={retry}
      legend={[{ zone: 'eastern', name: 'Восточная', hex: '#0891B2', count: 1 }]} />);
    fireEvent.click(screen.getByRole('button', { name: /Маршруты по зонам · 1/ }));
    expect(screen.getByText(MAP_TEXT.partial)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: MAP_TEXT.retry }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('при замене дня отказ части интересов тоже виден', () => {
    render(<PlannerMapOverlay {...base} status="ok" total={1} partial hasPlan editing={editingDay()}
      legend={[{ zone: 'eastern', name: 'Восточная', hex: '#0891B2', count: 1 }]} />);
    expect(screen.getByText(MAP_TEXT.partial)).toBeTruthy();
  });

  it('день, который не заменяют, — причина словами, без «нажмите точку»', () => {
    render(<PlannerMapOverlay {...base} status="ok" total={3} hasPlan
      editing={editingDay({ number: 1, title: 'Прилёт', refusal: 'Это день прилёта — его не заменяют маршрутом.' })} />);
    expect(screen.getByText('Это день прилёта — его не заменяют маршрутом.')).toBeTruthy();
    expect(screen.getByText('День 1: Прилёт')).toBeTruthy();
    expect(screen.queryByText(MAP_TEXT.editAction)).toBeNull();
    expect(screen.queryByText(MAP_TEXT.editColors)).toBeNull();
    expect(screen.getByRole('button', { name: 'Закрыть день' })).toBeTruthy();
  });

  it('серые при замене — «другая зона или зона не записана»; ярких нет — так и сказано', () => {
    const { rerender } = render(<PlannerMapOverlay {...base} status="ok" total={3} hasPlan editing={editingDay()} />);
    expect(screen.getByText(MAP_TEXT.editColors).textContent).toMatch(/зона не записана/);
    rerender(<PlannerMapOverlay {...base} status="ok" total={3} hasPlan editing={editingDay({ sameZone: 0 })} />);
    expect(screen.queryByText(MAP_TEXT.editColors)).toBeNull();
    expect(screen.getByText(MAP_TEXT.editNoSameZone)).toBeTruthy();
  });

  it('отказ загрузки зовёт к кнопке, а не к перезагрузке страницы (план не хранится)', () => {
    render(<PlannerMapOverlay {...base} status="failed" />);
    expect(MAP_TEXT.failed).toMatch(/«Повторить»/);
    expect(MAP_TEXT.failed).not.toMatch(/обновите страницу/);
    expect(screen.getByRole('alert').textContent).toContain(MAP_TEXT.retry);
  });

  it('план появился — на телефоне легенда сворачивается сама, строка о днях остаётся', () => {
    const legend = [{ zone: 'northern' as const, name: 'Северная', hex: '#15803D', count: 2 }];
    const { rerender } = render(<PlannerMapOverlay {...base} status="ok" total={2} legend={legend} />);
    const toggle = screen.getByRole('button', { name: /Маршруты по зонам · 2/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    rerender(<PlannerMapOverlay {...base} status="ok" total={2} legend={legend} hasPlan />);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText(MAP_TEXT.days)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Цвета зон на карте' })).toBeNull();
  });

  it('на широком экране легенда сама не сворачивается', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('min-width: 1024px'), media: q }));
    const legend = [{ zone: 'northern' as const, name: 'Северная', hex: '#15803D', count: 2 }];
    const { rerender } = render(<PlannerMapOverlay {...base} status="ok" total={2} legend={legend} />);
    rerender(<PlannerMapOverlay {...base} status="ok" total={2} legend={legend} hasPlan />);
    expect(screen.getByRole('button', { name: /Маршруты по зонам · 2/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(MAP_TEXT.hintPlan)).toBeTruthy();
  });
});
