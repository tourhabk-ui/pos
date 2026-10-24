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
 *
 * Третий круг ревью 22.10:
 *   — «Заменить» в карточке маршрута меняет тот день, что показан в списке:
 *     после «Закрыть день» на прилёте и после удаления открытого дня кнопка
 *     слала прежний день — отказ на скрытой вкладке или молчаливое закрытие;
 *   — замена дня без записанной зоны не красит точки угаданной зоны, и
 *     плашка говорит это словами.
 *
 * Третий круг, мелкое:
 *   — «маршрутов нет» называет, что искали: точки ищутся по виду маршрута,
 *     плитка места («Вулканы») такой пометкой не бывает; без выбора —
 *     «показаны маршруты с пометкой …», а не «по вашим интересам»;
 *   — заменяемый день открыт, загрузка отказала — плашка дня говорит
 *     «Точек нет…», «Повторить» одна;
 *   — открыт день, который не заменяют, — легенда остаётся свёрнутой, и
 *     список дней говорит «день прилёта не заменяют», а не «кликните карту»;
 *   — «что нажать» при замене — слова кнопки карточки точки;
 *   — пока плана нет, карточка точки не предлагает «Добавить в план».
 *
 * Пятый круг (22.10):
 *   — плитки мест дают точки: каждая ищет маршрут по месту пути
 *     (`place_type`), а не по виду маршрута;
 *   — без выбора и отказе одного из интересов по умолчанию строка
 *     «Интересы не выбраны — на карте маршруты: …» его не называет, а
 *     предупреждение видно; отказ не называется «не нашли»;
 *   — пустой исход называет искомое словами анкеты и что делать, и только
 *     когда на карте пусто;
 *   — на телефоне открытая карточка точки сворачивает легенду, а
 *     предупреждение стоит над легендой; на компьютере легенда у
 *     незаменяемого дня сама не сворачивается;
 *   — в плашке дня при отказе — следствие, а не второй отказ.
 *
 * Шестой круг (22.10):
 *   — отказ при открытом дне — одна плашка (отказ, что это для дня,
 *     «Повторить»), а не две подряд;
 *   — частичный отказ называет, что не загрузилось, и это имя не попадает
 *     в «На карте нет маршрутов»;
 *   — «…или поставить вместо дня» — только если в плане есть заменяемый
 *     день (план из прилёта и отъезда этого не обещает);
 *   — каталог знает больше, чем показано, — «показаны N из M»;
 *   — карточка точки встаёт под низ колонки плашек, а на телефоне плашка
 *     замены при открытой карточке не повторяет «нажмите точку»;
 *   — смена ширины экрана (matchMedia change) меняет правило легенды
 *     у незаменяемого дня без перезагрузки.
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
import {
  PlannerMapOverlay, MAP_TEXT, editActionText, editFailedText, emptyKindsText, byDefaultText, emptyText,
  partialText, truncatedText,
} from '@/components/planner/PlannerMapOverlay';
import { resolveMarkerColor } from '@/lib/map/marker-colors';
import { plannerLegend } from '@/lib/planner/map-markers';
import { NO_ZONE_PIN, ZONE_PIN } from '@/lib/planner/zone-style';

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

/** План только из каркаса: прилёт и отъезд — заменять маршрутом нечего. */
const FRAME_ONLY = {
  zones: [], warnings: [], itinerary: '',
  days: [
    { ...day(1, 'avachinsky', 'Прилёт', PKC), type: 'arrival' },
    { ...day(2, 'avachinsky', 'Вылет', PKC), type: 'departure' },
  ],
  priceBreakdown: PRICES,
};

type RoutesReply = 'data' | 'empty' | 'fail';
let routesReply: RoutesReply = 'data';
let routesData: unknown[] = CATALOG;
/**
 * Ответ каталога по интересу: ключ — `activity_type` (занятие) или
 * `place_type` (место пути); интереса нет в записи — пусто, 'fail' — 503.
 */
let routesByType: Record<string, unknown[] | 'fail'> | null = null;
/** `meta.total` каталога по интересу (ключ как у routesByType); нет — meta не отдаётся. */
let routesTotals: Record<string, number> = {};
let routesCalls = 0;
let routesUrls: string[] = [];
let recommendation: unknown = RECOMMENDATION;
/** Пока true — ответы каталога ждут release(data): «медленная связь». */
let holdRoutes = false;
let held: Array<(data: unknown[]) => void> = [];

const okRoutes = (data: unknown[], total?: number) => ({
  ok: true, status: 200,
  json: async () => ({ success: true, data, ...(total === undefined ? {} : { meta: { total, page: 1, limit: 30, pages: Math.ceil(total / 30) } }) }),
} as Response);

beforeEach(() => {
  routesReply = 'data';
  routesData = CATALOG;
  routesByType = null;
  routesTotals = {};
  routesCalls = 0;
  routesUrls = [];
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
      routesUrls.push(u);
      if (holdRoutes) return new Promise<Response>(res => { held.push(data => res(okRoutes(data))); });
      if (routesReply === 'fail') return { ok: false, status: 503, json: async () => ({ success: false }) } as Response;
      if (routesByType) {
        const sp = new URL(u, 'http://x').searchParams;
        const key = sp.get('activity_type') ?? sp.get('place_type') ?? '';
        const reply = routesByType[key];
        if (reply === 'fail') return { ok: false, status: 503, json: async () => ({ success: false }) } as Response;
        return okRoutes(reply ?? [], routesTotals[key]);
      }
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
  fireEvent.change(screen.getByLabelText('Дата прилёта'), { target: { value: '03.08.2027' } });
  fireEvent.change(screen.getByLabelText('Дата отъезда'), { target: { value: '12.08.2027' } });
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
    expect(screen.queryByText(/На карте нет маршрутов/)).toBeNull();
    const before = routesCalls;
    routesReply = 'data';
    fireEvent.click(screen.getByRole('button', { name: MAP_TEXT.retry }));
    await waitFor(() => expect(routesCalls).toBeGreaterThan(before));
    await screen.findByText(new RegExp(`${MAP_TEXT.legendTitle} · 5`));
    expect(screen.queryByText(MAP_TEXT.failed)).toBeNull();
  });

  it('каталог ответил пусто — «маршрутов нет», а не отказ и не молчание', async () => {
    routesReply = 'empty';
    const { container } = render(<PlannerClient />);
    // Интересы не выбраны — спрошены интересы по умолчанию, и сказано, какие и что делать.
    const plaque = await screen.findByText(emptyText({ byDefault: true, shown: [], empty: ['Треккинг', 'Вулканы'] }));
    expect(plaque.textContent).toBe(
      'На карте нет маршрутов: «Треккинг», «Вулканы». Выберите интересы в шаге «Что интересно».',
    );
    expect(screen.queryByText(MAP_TEXT.failed)).toBeNull();
    expect(container.textContent).not.toMatch(/по вашим интересам|Для выбранных интересов|пометк|виду маршрута/);
  });

  it('выбраны «Вулканы», маршрутов через вулканы нет — сказано, что искали, и что делать', async () => {
    routesByType = { trekking: CATALOG };
    const { container } = render(<PlannerClient />);
    toInterests();
    fireEvent.click(screen.getByRole('button', { name: /Вулканы/ }));
    const plaque = await screen.findByText(emptyText({ byDefault: false, shown: [], empty: ['Вулканы'] }));
    expect(plaque.getAttribute('role')).toBe('status');
    expect(plaque.textContent).toBe(
      'На карте нет маршрутов: «Вулканы». Добавьте занятие или место в шаге «Что интересно».',
    );
    // Интересы выбраны — «выберите интересы» тут не к месту.
    expect(plaque.textContent).not.toMatch(/Выберите интересы/);
    expect(container.textContent).not.toMatch(/Для выбранных интересов|пометк|виду маршрута/);
  });

  it('без выбора — «на карте маршруты: «Треккинг»», а не «под ваши интересы»', async () => {
    routesByType = { trekking: CATALOG };
    const { container } = render(<PlannerClient />);
    expect(await screen.findByText(byDefaultText(['Треккинг']))).toBeTruthy();
    expect(byDefaultText(['Треккинг'])).toBe('Интересы не выбраны — на карте маршруты: «Треккинг». Свои — в шаге «Что интересно».');
    expect(screen.getByText(MAP_TEXT.hintTap)).toBeTruthy();
    expect(screen.queryByText(MAP_TEXT.hintNoPlan)).toBeNull();
    // Пустые интересы по умолчанию человек не выбирал — ими его не грузим.
    expect(screen.queryByText(/На карте нет маршрутов/)).toBeNull();
    expect(container.textContent).not.toMatch(/пометк|виду маршрута/);
  });

  it('выбраны «Вулканы» и «Треккинг» — точки треккинга есть, «Вулканы» названы, а «что делать» не навязывается', async () => {
    routesByType = { trekking: CATALOG };
    render(<PlannerClient />);
    toInterests();
    fireEvent.click(screen.getByRole('button', { name: /Вулканы/ }));
    fireEvent.click(screen.getByRole('button', { name: /Треккинг/ }));
    await screen.findByText(new RegExp(`${MAP_TEXT.legendTitle} · 5`));
    expect(await screen.findByText(emptyKindsText(['Вулканы']))).toBeTruthy();
    expect(screen.getByText(MAP_TEXT.hintNoPlan)).toBeTruthy();
    expect(screen.queryByText(/Интересы не выбраны/)).toBeNull();
    // Точки на карте есть — «добавьте занятие» было бы не к месту.
    expect(screen.queryByText(new RegExp(MAP_TEXT.addInterest))).toBeNull();
  });

  it('плитка «Вулканы» даёт точки: маршруты через вулкан приходят по месту пути', async () => {
    routesByType = { volcano: [CATALOG[0], CATALOG[3]] };
    render(<PlannerClient />);
    toInterests();
    fireEvent.click(screen.getByRole('button', { name: /Вулканы/ }));
    await screen.findByText(new RegExp(`${MAP_TEXT.legendTitle} · 2$`));
    expect(markers().map(m => m.id).sort()).toEqual(['r1', 'r4']);
    const last = new URL(routesUrls[routesUrls.length - 1], 'http://x').searchParams;
    expect(last.get('place_type')).toBe('volcano');
    expect(last.get('activity_type')).toBeNull();
    expect(screen.queryByText(/На карте нет маршрутов/)).toBeNull();
  });

  it('все плитки мест ищут по месту пути, ни одна — по виду маршрута', async () => {
    render(<PlannerClient />);
    toInterests();
    const group = screen.getByText('Места').parentElement as HTMLElement;
    const tiles = within(group).getAllByRole('button');
    expect(tiles.length).toBeGreaterThanOrEqual(6);
    const before = routesUrls.length;
    for (const tile of tiles) fireEvent.click(tile);
    await waitFor(() => expect(routesUrls.length).toBeGreaterThan(before));
    const asked = routesUrls.slice(before).map(u => new URL(u, 'http://x').searchParams);
    for (const sp of asked) {
      expect(sp.get('activity_type'), sp.toString()).toBeNull();
      expect(sp.get('place_type'), sp.toString()).toMatch(/^[a-z_]+(,[a-z_]+)*$/);
    }
    // Каждая плитка — свой запрос: шесть разных наборов видов мест в последнем выборе.
    const lastBatch = new Set(asked.slice(-tiles.length).map(sp => sp.get('place_type')));
    expect(lastBatch.size).toBe(tiles.length);
  });

  it('без выбора, «Вулканы» не загрузились — «на карте маршруты» их не называет, предупреждение видно', async () => {
    routesByType = { trekking: CATALOG, volcano: 'fail' };
    render(<PlannerClient />);
    const line = await screen.findByText(byDefaultText(['Треккинг']));
    expect(line.textContent).not.toMatch(/Вулканы/);
    const warn = screen.getByText(partialText(['Вулканы'])).closest('[role="status"]') as HTMLElement;
    expect(within(warn).getByRole('button', { name: MAP_TEXT.retry })).toBeTruthy();
    // Отказ — не «не нашли».
    expect(screen.queryByText(/На карте нет маршрутов/)).toBeNull();
  });

  it('выбраны «Треккинг» и «Рыбалка», «Рыбалка» не загрузилась — это отказ, а не «не нашли»', async () => {
    routesByType = { trekking: CATALOG, fishing: 'fail' };
    const { container } = render(<PlannerClient />);
    toInterests();
    fireEvent.click(screen.getByRole('button', { name: /Треккинг/ }));
    fireEvent.click(screen.getByRole('button', { name: /Рыбалка/ }));
    await screen.findByText(partialText(['Рыбалка']));
    await screen.findByText(new RegExp(`${MAP_TEXT.legendTitle} · 5`));
    expect(screen.queryByText(/На карте нет маршрутов/)).toBeNull();
    expect(container.textContent).not.toContain(emptyKindsText(['Рыбалка']));
  });

  it('пока плана нет, карточка точки не предлагает «Добавить в план»', async () => {
    render(<PlannerClient />);
    await screen.findByText(new RegExp(`${MAP_TEXT.legendTitle} · 5`));
    tap('r1');
    // Карточка точки открылась — со ссылкой на маршрут и словами, когда её можно поставить.
    expect(await screen.findByRole('link', { name: 'Открыть страницу маршрута' })).toBeTruthy();
    expect(screen.getByText(/Сначала соберите план поездки/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Добавить в план/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Заменить/ })).toBeNull();
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
    // Интересы ещё не выбраны: подсказка без «под ваши интересы».
    await screen.findByText(MAP_TEXT.hintTap);
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
    expect(screen.queryByText(/Нажмите точку, затем/)).toBeNull();
    tap('r1');
    await screen.findByRole('button', { name: /Добавить в план/ });
    expect(screen.queryByRole('button', { name: /Заменить/ })).toBeNull();

    tap('day_2');
    const action = await screen.findByText(editActionText(2));
    tap('r1');
    const button = await screen.findByRole('button', { name: 'Заменить день 2' });
    // Плашка называет ровно ту кнопку, что в карточке точки.
    expect(action.textContent).toContain(`«${button.textContent?.trim()}»`);
  });

  it('открыт день, который не заменяют, — легенда остаётся свёрнутой; развернуть можно', async () => {
    recommendation = FRAMED;
    render(<PlannerClient />);
    await buildPlan();
    tap(markers().find(m => m.label === '1·3')?.id ?? '');
    await screen.findByText('Это день прилёта — его не заменяют маршрутом.');
    const toggle = screen.getByRole('button', { name: new RegExp(`${MAP_TEXT.legendTitle} · 5`) });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('list', { name: 'Цвета зон на карте' })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('list', { name: 'Цвета зон на карте' })).toBeTruthy();
    // У этого дня карточка точки предлагает только «Добавить в план» — подсказка о том же.
    expect(screen.getByText(MAP_TEXT.hintAddOnly)).toBeTruthy();
    expect(screen.queryByText(MAP_TEXT.hintPlan)).toBeNull();
  });

  it('список дней: у открытого прилёта — «день прилёта не заменяют», а не «кликните карту»', async () => {
    recommendation = FRAMED;
    render(<PlannerClient />);
    await buildPlan();
    tap(markers().find(m => m.label === '1·3')?.id ?? '');
    await screen.findByText('Это день прилёта — его не заменяют маршрутом.');
    expect(screen.queryByText('кликните карту для замены')).toBeNull();
    expect(screen.getByText('день прилёта не заменяют')).toBeTruthy();
    const arrival = screen.getByText('— день прилёта не заменяют').closest('li') as HTMLElement;
    expect(within(arrival).getByText('Прилёт', { selector: 'p' })).toBeTruthy();
    expect(screen.queryByText('— редактирование')).toBeNull();

    // Обычный день — прежние слова.
    tap('day_2');
    await screen.findByText(editActionText(2));
    expect(screen.getByText('кликните карту для замены')).toBeTruthy();
    expect(screen.getByText('— редактирование')).toBeTruthy();
    expect(screen.queryByText(/не заменяют$/)).toBeNull();
  });

  it('заменяемый день открыт, маршруты не загрузились — одна плашка: отказ, что это для дня, «Повторить»', async () => {
    routesReply = 'fail';
    render(<PlannerClient />);
    await buildPlan();
    await screen.findByText(MAP_TEXT.failed);
    tap('day_2');
    const line = await screen.findByText(editFailedText(2));
    expect(line.textContent).toBe('Маршруты не загрузились — заменить день 2 можно после «Повторить».');
    // Одна плашка: в ней и «Закончить замену дня», и «Повторить», и это тревога.
    const plaque = line.closest('div.fx-glass-dense') as HTMLElement;
    expect(within(plaque).getByRole('button', { name: 'Закончить замену дня' })).toBeTruthy();
    expect(within(plaque).getByRole('button', { name: MAP_TEXT.retry })).toBeTruthy();
    expect(line.closest('[role="alert"]')).toBeTruthy();
    // Второй плашки отказа нет — колонка не растёт на северный пин дня.
    expect(screen.getAllByRole('button', { name: MAP_TEXT.retry })).toHaveLength(1);
    expect(screen.queryByText(MAP_TEXT.failed)).toBeNull();
    expect(document.querySelectorAll('div.fx-glass-dense')).toHaveLength(1);
    // «Повторить» спрашивает снова — и день остаётся открытым.
    const before = routesCalls;
    routesReply = 'data';
    fireEvent.click(within(plaque).getByRole('button', { name: MAP_TEXT.retry }));
    await waitFor(() => expect(routesCalls).toBeGreaterThan(before));
    expect(await screen.findByText(editActionText(2))).toBeTruthy();
  });

  it('телефон: открыта карточка точки — легенда свёрнута, предупреждение над легендой; закрыл — как было', async () => {
    routesByType = { trekking: CATALOG, volcano: 'fail' };
    render(<PlannerClient />);
    const toggle = await screen.findByRole('button', { name: new RegExp(`${MAP_TEXT.legendTitle} · 5`) });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const warn = screen.getByText(partialText(['Вулканы'])).closest('[role="status"]') as HTMLElement;
    // Предупреждение — выше легенды в колонке: карточка встаёт под низ колонки.
    expect(warn.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    tap('r1');
    await screen.findByRole('link', { name: 'Открыть страницу маршрута' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('list', { name: 'Цвета зон на карте' })).toBeNull();
    expect(screen.getByText(partialText(['Вулканы']))).toBeTruthy();
    // Развернуть можно и при карточке.
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);

    fireEvent.click(screen.getByRole('button', { name: 'Закрыть карточку маршрута' }));
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('true'));
    expect(screen.getByRole('list', { name: 'Цвета зон на карте' })).toBeTruthy();
  });

  it('частичный отказ называет, что не загрузилось, — и это имя не попадает в «На карте нет маршрутов»', async () => {
    routesByType = { trekking: CATALOG, volcano: 'fail' };
    const { container } = render(<PlannerClient />);
    toInterests();
    fireEvent.click(screen.getByRole('button', { name: /Вулканы/ }));
    fireEvent.click(screen.getByRole('button', { name: /Гейзеры/ }));
    fireEvent.click(screen.getByRole('button', { name: /Треккинг/ }));
    const warn = await screen.findByText(partialText(['Вулканы']));
    expect(warn.textContent).toBe('Не загрузились: «Вулканы». Проверьте связь и нажмите «Повторить».');
    expect(within(warn.closest('[role="status"]') as HTMLElement).getByRole('button', { name: MAP_TEXT.retry })).toBeTruthy();
    // «Гейзеры» ответили пусто — это «нет», и только они.
    const none = await screen.findByText(emptyKindsText(['Гейзеры']));
    expect(none.textContent).not.toMatch(/Вулканы/);
    expect(container.textContent).not.toContain(emptyKindsText(['Вулканы']));
    expect(container.textContent).not.toContain(emptyKindsText(['Гейзеры', 'Вулканы']));
    expect(container.textContent).not.toContain(emptyKindsText(['Вулканы', 'Гейзеры']));
  });

  it('план из прилёта и отъезда — подсказка не обещает «поставить вместо дня»', async () => {
    recommendation = FRAME_ONLY;
    render(<PlannerClient />);
    await buildPlan();
    // Сначала легенда сворачивается сама (план появился, телефон) — и только
    // потом нажатие её разворачивает. Нажать раньше эффекта — свернуть её
    // нажатием, а эффект оставит свёрнутой (CI 22.10, PR #2703).
    const toggle = screen.getByRole('button', { name: new RegExp(MAP_TEXT.legendTitle) });
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'));
    fireEvent.click(toggle);
    expect(screen.getByText(MAP_TEXT.hintAddOnly)).toBeTruthy();
    expect(screen.queryByText(MAP_TEXT.hintPlan)).toBeNull();
    // И карточка точки — о том же: только «Добавить в план».
    tap('r1');
    await screen.findByRole('button', { name: /Добавить в план/ });
    expect(screen.queryByRole('button', { name: /Заменить/ })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Какой день заменить' })).toBeNull();
  });

  it('каталог знает больше, чем пришло, — легенда говорит «показаны N из M» по интересу', async () => {
    routesByType = { trekking: CATALOG, volcano: [CATALOG[0]] };
    routesTotals = { trekking: CATALOG.length, volcano: 52 };
    render(<PlannerClient />);
    const line = await screen.findByText(truncatedText([{ label: 'Вулканы', shown: 1, total: 52 }]));
    expect(line.textContent).toBe('«Вулканы» — показаны 1 из 52.');
    // Треккинг пришёл весь — о нём ни слова.
    expect(line.textContent).not.toMatch(/Треккинг/);
    // На карте — то, что пришло, без выдумки: пять точек (r1 в обоих интересах).
    expect(screen.getByRole('button', { name: new RegExp(`${MAP_TEXT.legendTitle} · 5`) })).toBeTruthy();
  });

  it('карточка точки встаёт под низ колонки плашек: её верх — низ колонки, и меняется вместе с колонкой', async () => {
    const observers: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class {
      private cb: () => void;
      constructor(cb: () => void) { this.cb = cb; observers.push(() => this.cb()); }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    routesByType = { trekking: CATALOG, volcano: 'fail' };
    render(<PlannerClient />);
    const toggle = await screen.findByRole('button', { name: new RegExp(`${MAP_TEXT.legendTitle} · 5`) });
    const column = toggle.closest('[data-theme="dark"]') as HTMLElement;
    Object.defineProperty(column, 'offsetTop', { configurable: true, value: 12 });
    Object.defineProperty(column, 'offsetHeight', { configurable: true, value: 180 });
    act(() => { for (const f of observers) f(); });
    tap('r1');
    const link = await screen.findByRole('link', { name: 'Открыть страницу маршрута' });
    const wrapper = link.closest('[style]') as HTMLElement;
    // 12 + 180 + зазор 8: карточка начинается ниже «Повторить».
    expect(wrapper.style.top).toBe('200px');
    // Колонка стала короче (легенда свернулась при карточке) — карточка выше.
    Object.defineProperty(column, 'offsetHeight', { configurable: true, value: 90 });
    act(() => { for (const f of observers) f(); });
    expect(wrapper.style.top).toBe('110px');
    // Не помещается — прокручивается внутри, а не наезжает на колонку.
    expect((link.closest('.overflow-y-auto') as HTMLElement | null)).toBeTruthy();
  });

  it('карта отсылает к «Что интересно» — после сборки плана строка сводки называется так же и открывает этот шаг', async () => {
    routesReply = 'empty';
    render(<PlannerClient />);
    await buildPlan();
    expect(screen.getByText(emptyText({ byDefault: false, shown: [], empty: ['Вулканы'] }))).toBeTruthy();
    expect(MAP_TEXT.addInterest).toContain('«Что интересно»');
    fireEvent.click(screen.getByRole('button', { name: /^Что интересно/ }));
    expect(await screen.findByText(/Места и занятия — из них соберём дни/)).toBeTruthy();
  });

  it('без открытого дня «Заменить» предлагает только те дни, где замена сработает', async () => {
    recommendation = FRAMED;
    render(<PlannerClient />);
    await buildPlan();
    tap('r1');
    const select = await screen.findByRole('combobox', { name: 'Какой день заменить' });
    expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['День 2: Курильское озеро']);
  });

  /** Заголовки дней на карте в порядке плана: «1. Прилёт» … */
  const dayTitles = () => markers().filter(m => m.label).flatMap(m => m.title.split(' · '));

  it('«Заменить» после «Закрыть день» на прилёте меняет показанный день, а не прилёт', async () => {
    recommendation = FRAMED;
    render(<PlannerClient />);
    await buildPlan();
    // Пин «1·3» открывает прилёт — его не заменяют; точка — карточка без «Заменить».
    tap(markers().find(m => m.label === '1·3')?.id ?? '');
    await screen.findByText('Это день прилёта — его не заменяют маршрутом.');
    tap('r1');
    await screen.findByRole('button', { name: /Добавить в план/ });
    fireEvent.click(screen.getByRole('button', { name: 'Закрыть день' }));
    const select = await screen.findByRole('combobox', { name: 'Какой день заменить' }) as HTMLSelectElement;
    // В списке — только день 2, и выбран именно он.
    expect(select.value).toBe('2');
    fireEvent.click(screen.getByRole('button', { name: 'Заменить' }));
    await waitFor(() => expect(dayTitles()).toContain('2. Вулкан Авачинский'));
    expect(dayTitles()).toContain('1. Прилёт');
    expect(screen.queryByText(/его не заменяют маршрутом/)).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Какой день заменить' })).toBeNull();
  });

  it('открытый день удалили — «Заменить» меняет день, что показан в списке, а не закрывает карточку молча', async () => {
    render(<PlannerClient />);
    await buildPlan();
    tap('day_2');
    await screen.findByText(editActionText(2));
    tap('r4');
    await screen.findByRole('button', { name: 'Заменить день 2' });
    // День 2 удалён в плане — правка дня закрылась, карточка точки осталась.
    fireEvent.click(screen.getAllByTitle('Удалить день')[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Удалить' }));
    const select = await screen.findByRole('combobox', { name: 'Какой день заменить' }) as HTMLSelectElement;
    expect(select.value).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Заменить' }));
    await waitFor(() => expect(dayTitles()).toEqual(['1. Вулкан Толбачик']));
  });

  it('замена дня без записанной зоны — точки угаданной зоны не ярче прочих, плашка говорит почему', async () => {
    render(<PlannerClient />);
    await buildPlan();
    tap('r5');
    fireEvent.click(await screen.findByRole('button', { name: /Добавить в план/ }));
    await waitFor(() => expect(dayTitles()).toContain('3. Маршрут без зоны'));
    // До замены авачинская точка — своим цветом.
    expect(markers().find(m => m.id === 'r1')?.color).toBe(ZONE_PIN.avachinsky);
    tap(markers().find(m => m.label === '3')?.id ?? '');
    await screen.findByText(MAP_TEXT.editZoneNotRecorded);
    const dots = markers().filter(m => CATALOG.some(r => r.id === m.id));
    expect(dots.map(m => m.color)).toEqual(CATALOG.map(() => NO_ZONE_PIN));
    expect(screen.queryByText(MAP_TEXT.editColors)).toBeNull();
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
  const editingDay = (over: Partial<{ number: number; title: string; refusal: string | null; sameZone: number; dayZone: string | null }> = {}) =>
    ({ number: 2, title: 'Курильское озеро', refusal: null, sameZone: 3, dayZone: 'western', ...over });

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
    expect(screen.getByText('Нажмите точку, затем «Заменить день 2».')).toBeTruthy();
    expect(screen.getByText(MAP_TEXT.editColors)).toBeTruthy();
    // Легенда при замене не спорит с плашкой замены.
    expect(screen.queryByRole('list', { name: 'Цвета зон на карте' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Закончить замену дня' }));
    expect(stop).toHaveBeenCalled();
  });

  it('замена дня, а точек нет — плашка замены говорит почему, а не «нажмите точку»', () => {
    render(<PlannerMapOverlay {...base} status="empty" hasPlan editing={editingDay({ number: 1, title: 'Мутновский' })}
      search={{ byDefault: false, shown: [], empty: ['Вулканы'] }} />);
    expect(screen.getByText(emptyText({ byDefault: false, shown: [], empty: ['Вулканы'] }))).toBeTruthy();
    expect(screen.queryByText(/Нажмите точку, затем/)).toBeNull();
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('отказ при открытом дне — одна плашка с «Повторить»; у незаменяемого — причина и отказ, без обещания замены', () => {
    const retry = vi.fn();
    const { rerender } = render(<PlannerMapOverlay {...base} status="failed" hasPlan editing={editingDay()} onRetry={retry} />);
    expect(screen.getByText(editFailedText(2))).toBeTruthy();
    expect(screen.getAllByRole('button', { name: MAP_TEXT.retry })).toHaveLength(1);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: MAP_TEXT.retry }));
    expect(retry).toHaveBeenCalledTimes(1);
    rerender(<PlannerMapOverlay {...base} status="failed" hasPlan onRetry={retry}
      editing={editingDay({ number: 1, title: 'Прилёт', refusal: 'Это день прилёта — его не заменяют маршрутом.' })} />);
    expect(screen.queryByText(/заменить день/)).toBeNull();
    expect(screen.getByText('Это день прилёта — его не заменяют маршрутом.')).toBeTruthy();
    // Отказ тот же, и тоже в плашке дня — вторая плашка не появляется.
    const failed = screen.getByText(MAP_TEXT.failed);
    expect(within(failed.closest('div.fx-glass-dense') as HTMLElement).getByRole('button', { name: 'Закрыть день' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: MAP_TEXT.retry })).toHaveLength(1);
    // Без открытого дня — отдельная плашка отказа, как прежде.
    rerender(<PlannerMapOverlay {...base} status="failed" onRetry={retry} />);
    expect(screen.getByRole('alert').textContent).toContain(MAP_TEXT.failed);
  });

  it('незаменяемый день: легенда свёрнута, раскрытие помнится для этого дня, у другого — снова свёрнута', () => {
    const legend = [{ zone: 'northern' as const, name: 'Северная', hex: '#15803D', count: 2 }];
    const fixed = (n: number) => editingDay({ number: n, title: 'Прилёт', refusal: 'Это день прилёта — его не заменяют маршрутом.' });
    const { rerender } = render(<PlannerMapOverlay {...base} status="ok" total={2} legend={legend} hasPlan editing={fixed(1)} />);
    const toggle = screen.getByRole('button', { name: /Маршруты по зонам · 2/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByRole('list', { name: 'Цвета зон на карте' })).toBeTruthy();
    rerender(<PlannerMapOverlay {...base} status="ok" total={2} legend={legend} hasPlan editing={fixed(3)} />);
    expect(screen.getByRole('button', { name: /Маршруты по зонам · 2/ }).getAttribute('aria-expanded')).toBe('false');
    // Заменяемый день — легенды нет: плашка замены сама говорит про цвета.
    rerender(<PlannerMapOverlay {...base} status="ok" total={2} legend={legend} hasPlan editing={editingDay()} />);
    expect(screen.queryByRole('button', { name: /Маршруты по зонам/ })).toBeNull();
  });

  it('пусто без выбора интересов — «выберите интересы»; с выбором — «добавьте занятие или место»', () => {
    const { rerender } = render(<PlannerMapOverlay {...base} status="empty"
      search={{ byDefault: true, shown: [], empty: ['Треккинг', 'Вулканы'] }} />);
    expect(screen.getByRole('status').textContent)
      .toBe('На карте нет маршрутов: «Треккинг», «Вулканы». Выберите интересы в шаге «Что интересно».');
    rerender(<PlannerMapOverlay {...base} status="empty" search={{ byDefault: false, shown: [], empty: ['Гейзеры'] }} />);
    expect(screen.getByRole('status').textContent)
      .toBe('На карте нет маршрутов: «Гейзеры». Добавьте занятие или место в шаге «Что интересно».');
    // Каталог ответил, а назвать нечего — без подписей, но с тем же «что делать».
    rerender(<PlannerMapOverlay {...base} status="empty" search={{ byDefault: false, shown: [], empty: [] }} />);
    expect(screen.getByRole('status').textContent)
      .toBe(`${MAP_TEXT.emptyBare} ${MAP_TEXT.addInterest}`);
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
    expect(screen.queryByText(/Нажмите точку, затем/)).toBeNull();
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

  it('зона дня не записана или вне четырёх — «той же зоны» нет, сказано словами', () => {
    const { rerender } = render(<PlannerMapOverlay {...base} status="ok" total={3} hasPlan
      editing={editingDay({ dayZone: null, sameZone: 0 })} />);
    expect(screen.getByText(MAP_TEXT.editZoneNotRecorded)).toBeTruthy();
    expect(screen.queryByText(MAP_TEXT.editNoSameZone)).toBeNull();
    rerender(<PlannerMapOverlay {...base} status="ok" total={3} hasPlan editing={editingDay({ dayZone: 'krai_koryak', sameZone: 0 })} />);
    expect(screen.getByText(MAP_TEXT.editZoneOutside)).toBeTruthy();
    expect(screen.queryByText(MAP_TEXT.editColors)).toBeNull();
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

  it('компьютер: у незаменяемого дня легенда сама не сворачивается, карточка точки её не сворачивает', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('min-width: 1024px'), media: q }));
    const legend = [{ zone: 'northern' as const, name: 'Северная', hex: '#15803D', count: 2 }];
    const fixed = editingDay({ number: 1, title: 'Прилёт', refusal: 'Это день прилёта — его не заменяют маршрутом.' });
    const { rerender } = render(<PlannerMapOverlay {...base} status="ok" total={2} legend={legend} hasPlan editing={fixed} />);
    const toggle = screen.getByRole('button', { name: /Маршруты по зонам · 2/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('list', { name: 'Цвета зон на карте' })).toBeTruthy();
    rerender(<PlannerMapOverlay {...base} status="ok" total={2} legend={legend} hasPlan editing={fixed} cardOpen />);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // Свернуть рукой — можно.
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('телефон: у незаменяемого дня легенда свёрнута и при открытой карточке тоже', () => {
    const legend = [{ zone: 'northern' as const, name: 'Северная', hex: '#15803D', count: 2 }];
    const fixed = editingDay({ number: 1, title: 'Прилёт', refusal: 'Это день прилёта — его не заменяют маршрутом.' });
    const { rerender } = render(<PlannerMapOverlay {...base} status="ok" total={2} legend={legend} hasPlan editing={fixed} partial />);
    const toggle = screen.getByRole('button', { name: /Маршруты по зонам · 2/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    rerender(<PlannerMapOverlay {...base} status="ok" total={2} legend={legend} hasPlan editing={fixed} partial cardOpen />);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText(MAP_TEXT.partial)).toBeTruthy();
    // Развернул при карточке, закрыл её и открыл другую — снова свёрнута:
    // раскрытие помнится для одной карточки, а не навсегда.
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    rerender(<PlannerMapOverlay {...base} status="ok" total={2} legend={legend} hasPlan editing={fixed} partial />);
    rerender(<PlannerMapOverlay {...base} status="ok" total={2} legend={legend} hasPlan editing={fixed} partial cardOpen />);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('телефон: карточка точки открыта при замене дня — плашка не повторяет «нажмите точку» и цвета; компьютер — повторяет', () => {
    const legend = [{ zone: 'western' as const, name: 'Западная', hex: '#15803D', count: 3 }];
    const { rerender } = render(<PlannerMapOverlay {...base} status="ok" total={3} legend={legend} hasPlan canReplace editing={editingDay()} />);
    expect(screen.getByText(editActionText(2))).toBeTruthy();
    expect(screen.getByText(MAP_TEXT.editColors)).toBeTruthy();
    rerender(<PlannerMapOverlay {...base} status="ok" total={3} legend={legend} hasPlan canReplace editing={editingDay()} cardOpen />);
    expect(screen.queryByText(editActionText(2))).toBeNull();
    expect(screen.queryByText(MAP_TEXT.editColors)).toBeNull();
    // Закончить замену можно и так.
    expect(screen.getByRole('button', { name: 'Закончить замену дня' })).toBeTruthy();
    cleanup();
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('min-width: 1024px'), media: q }));
    render(<PlannerMapOverlay {...base} status="ok" total={3} legend={legend} hasPlan canReplace editing={editingDay()} cardOpen />);
    expect(screen.getByText(editActionText(2))).toBeTruthy();
  });

  it('повернули экран (matchMedia change) — правило легенды у незаменяемого дня меняется без перезагрузки', () => {
    // Заглушка со списком слушателей: событие change доходит только до
    // подписанных — без подписки useWideScreen правило застыло бы на первом
    // рендере.
    let wideNow = true;
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', (q: string) => ({
      get matches() { return q.includes('min-width: 1024px') ? wideNow : false; },
      media: q,
      addEventListener: (_: string, f: () => void) => { listeners.add(f); },
      removeEventListener: (_: string, f: () => void) => { listeners.delete(f); },
    }));
    const change = (wide: boolean) => act(() => { wideNow = wide; for (const f of [...listeners]) f(); });
    const legend = [{ zone: 'northern' as const, name: 'Северная', hex: '#15803D', count: 2 }];
    const fixed = editingDay({ number: 1, title: 'Прилёт', refusal: 'Это день прилёта — его не заменяют маршрутом.' });
    const { unmount } = render(<PlannerMapOverlay {...base} status="ok" total={2} legend={legend} hasPlan editing={fixed} />);
    const toggle = screen.getByRole('button', { name: /Маршруты по зонам · 2/ });
    expect(listeners.size).toBeGreaterThan(0);
    // Компьютер — легенда развёрнута.
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // Узко (телефон) — сворачивается сама.
    change(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('list', { name: 'Цвета зон на карте' })).toBeNull();
    // Снова широко — развёрнута.
    change(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('list', { name: 'Цвета зон на карте' })).toBeTruthy();
    // Ушёл с экрана — отписался.
    unmount();
    expect(listeners.size).toBe(0);
  });

  it('на широком экране легенда сама не сворачивается', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('min-width: 1024px'), media: q }));
    const legend = [{ zone: 'northern' as const, name: 'Северная', hex: '#15803D', count: 2 }];
    const { rerender } = render(<PlannerMapOverlay {...base} status="ok" total={2} legend={legend} />);
    rerender(<PlannerMapOverlay {...base} status="ok" total={2} legend={legend} hasPlan canReplace />);
    expect(screen.getByRole('button', { name: /Маршруты по зонам · 2/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(MAP_TEXT.hintPlan)).toBeTruthy();
  });
});
