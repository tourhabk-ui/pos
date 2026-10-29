/**
 * Туры на карточке маршрута — правило 1в (слово владельца 29.10, «1в»).
 *
 * До 29.10 сервер ставил туры по `marketplace_score` вьюхи v_route_marketplace,
 * в который входила КОМИССИЯ платформы (оператор с меньшей ставкой стоял
 * выше), а клиент по умолчанию пересортировывал по цене и держал кнопку
 * «Рейтинг». Теперь сервер выстраивает туры правилом (ближайшая свободная
 * дата, остальные — жребием дня), клиент по умолчанию его не трогает, цену,
 * дату и места включает сам турист — под подписью правила.
 *
 * Проверяется поведением: вызов сборки карточки на строках вьюхи, чистая
 * сортировка выбора, рендер полосы выбора.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';

const queryMock = vi.hoisted(() => vi.fn());
const poolQuery = vi.hoisted(() => vi.fn());
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => queryMock(...a) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));

import { loadRouteDetail } from '@/lib/routes/route-detail';
import { orderOffers, OFFER_ORDER_NOTE, SORT_CHOICE_NOTE_RU } from '@/lib/tours/offer-order';
import { sortRouteOffers } from '@/lib/routes/route-offer-sort';
import { RouteOfferSortBar } from '@/components/routes/RouteOfferSortBar';

const ROUTE_ROW = {
  id: 'r-1', route_dedupe_key: 'r', route_id: null, category: 'route', location_type: null,
  activity_type: 'trekking', title: 'Вулкан Горелый', description: 'Подъём', lat: '52.5', lng: '158.0',
  source_url: null, source_name: null, payload: {}, created_at: '2026-01-01', kuzmich_review: null,
  has_real_image: false, kr_id: 'r-1', kr_ark_id: null,
};

/** Строка вьюхи: комиссия и «очки» вьюхи есть в данных — порядок их не читает. */
const offer = (id: number, extra: Record<string, unknown> = {}) => ({
  tour_id: id, tour_name: `Тур ${id}`, tour_short_desc: null, tour_price_base: 10000 + id, price_old: null,
  price_unit: 'per_person', effective_price: 10000 + id, tour_duration_hours: 8, duration_type: 'single_day',
  multi_day_count: null, tour_difficulty: 'medium', max_group_size: 10, min_group_size: 1, tour_rating: null,
  tour_review_count: null, included: [], season_start: null, season_end: null, operator_id: `p-${id}`,
  operator_name: `Компания ${id}`, operator_slug: null, operator_rating: null, operator_review_count: null,
  operator_verified: false, tour_image: null, operator_hero_image: null, next_departure_date: null,
  next_departure_slots: null, operator_public: true, commission_rate: 5 + id, marketplace_score: 100 - id,
  ...extra,
});

const NEAREST: Record<string, string | null> = { '1': null, '2': '2026-11-20', '3': null, '4': '2026-11-03', '5': null, '6': null };

function mockDb(offers: unknown[], nearest: 'ok' | 'fail' = 'ok') {
  queryMock.mockImplementation((sql: string) => {
    if (sql.includes('FROM agent_route_knowledge')) return Promise.resolve({ rows: [ROUTE_ROW] });
    if (sql.includes('FROM v_route_marketplace')) return Promise.resolve({ rows: offers });
    return Promise.resolve({ rows: [] });
  });
  poolQuery.mockImplementation((sql: string, params?: unknown[]) => {
    if (sql.includes('FROM operator_tours ot') && sql.includes('ANY($1::bigint[])')) {
      if (nearest === 'fail') return Promise.reject(Object.assign(new Error('canceling statement'), { code: '57014' }));
      const ids = (params?.[0] as string[]) ?? [];
      return Promise.resolve({ rows: ids.map((id) => ({ id, nearest_free_date: NEAREST[id] ?? null, nearest_free_seats: NEAREST[id] ? 4 : null })) });
    }
    return Promise.resolve({ rows: [] });
  });
}

type Loaded = { kind?: string; offers?: { tourId: number }[] } & Record<string, unknown>;
async function offerIds(): Promise<number[]> {
  const r = (await loadRouteDetail('r-1', { explain: false, countView: false })) as unknown as Loaded;
  const data = (r as { data?: Loaded }).data ?? r;
  return ((data.offers ?? []) as { tourId: number }[]).map((o) => o.tourId);
}

const rule = (ids: number[]) =>
  orderOffers(ids.map((id) => ({ id, nearestFreeDate: NEAREST[String(id)] ?? null }))).map((o) => Number(o.id));

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-29T03:00:00Z')); });
afterEach(() => { vi.useRealTimers(); cleanup(); vi.restoreAllMocks(); queryMock.mockReset(); poolQuery.mockReset(); });

describe('сервер: туры маршрута — правилом 1в, без комиссии', () => {
  it('порядок — orderOffers по ближайшей свободной дате; в SQL вьюхи нет ORDER BY marketplace_score', async () => {
    mockDb([1, 2, 3, 4, 5, 6].map((id) => offer(id)));
    const ids = await offerIds();
    expect(ids).toEqual(rule([1, 2, 3, 4, 5, 6]));
    expect(ids.slice(0, 2)).toEqual([4, 2]);
    const viewSql = String(queryMock.mock.calls.find(([s]) => String(s).includes('FROM v_route_marketplace'))![0]);
    expect(viewSql).not.toMatch(/marketplace_score|commission_rate/);
    expect(viewSql).not.toMatch(/ORDER BY/);
  });

  it('комиссия и «очки» вьюхи на порядок не влияют: другая ставка и другой порядок строк — тот же итог', async () => {
    mockDb([1, 2, 3, 4, 5, 6].map((id) => offer(id)));
    const a = await offerIds();
    mockDb([6, 5, 4, 3, 2, 1].map((id) => offer(id, { commission_rate: 30 - id, marketplace_score: id * 50 })));
    const b = await offerIds();
    expect(b).toEqual(a);
  });

  it('даты не прочитались — карточка открывается, туры идут жребием дня, отказ в логе с SQLSTATE', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockDb([1, 2, 3, 4].map((id) => offer(id)), 'fail');
    const ids = await offerIds();
    expect(ids).toEqual(orderOffers([1, 2, 3, 4].map((id) => ({ id, nearestFreeDate: null }))).map((o) => Number(o.id)));
    expect(err.mock.calls.flat().map(String).join(' ')).toMatch(/57014/);
  });
});

describe('сервер: дата и места на карточке — из того же источника, что порядок (ревью 29.10)', () => {
  type LoadedOffer = { tourId: number; nextDeparture: string | null; nextSlots: number | null; datesState?: string; effectivePrice: number | null; priceBase: number | null };
  async function loaded(): Promise<LoadedOffer[]> {
    const r = (await loadRouteDetail('r-1', { explain: false, countView: false })) as unknown as Loaded;
    const data = (r as { data?: Loaded }).data ?? r;
    return (data.offers ?? []) as unknown as LoadedOffer[];
  }

  it('вьюха говорит «5 ноября» (неоплаченная бронь её не видит) — карточка показывает свободную дату порядка', async () => {
    // Тур 2: у вьюхи 5.11 (booked_slots растёт только при оплате), реально свободно 20.11.
    mockDb([1, 2, 3, 4].map((id) => offer(id, id === 2 ? { next_departure_date: '2026-11-05', next_departure_slots: 10 } : {})));
    const offers = await loaded();
    const t2 = offers.find((o) => o.tourId === 2)!;
    expect(t2.nextDeparture).toBe('2026-11-20');
    expect(t2.nextSlots).toBe(4);
    expect(t2.datesState).toBe('ok');
    // Кнопка «Дата» не противоречит порядку по умолчанию для туров с датой.
    const dated = (list: LoadedOffer[]) => list.filter((o) => o.nextDeparture).map((o) => o.tourId);
    expect(dated(sortRouteOffers(offers, 'date'))).toEqual(dated(offers));
    // Тур без свободной даты — без даты на карточке, даже если вьюха её знает.
    mockDb([1, 3].map((id) => offer(id, { next_departure_date: '2026-11-01', next_departure_slots: 6 })));
    for (const o of await loaded()) { expect(o.nextDeparture).toBeNull(); expect(o.nextSlots).toBeNull(); }
  });

  it('даты не прочитались — у оффера «failed», а не дата вьюхи и не «дат нет»', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockDb([2, 4].map((id) => offer(id, { next_departure_date: '2026-11-05' })), 'fail');
    for (const o of await loaded()) {
      expect(o.datesState).toBe('failed');
      expect(o.nextDeparture).toBeNull();
    }
  });
});

describe('клиент: выбор туриста и подпись правила', () => {
  const o = (tourId: number, price: number | null, date: string | null, slots: number | null) =>
    ({ tourId, effectivePrice: price, priceBase: price, nextDeparture: date, nextSlots: slots });
  const server = [o(1, 30000, '2026-11-03', 2), o(2, 9000, null, null), o(3, 9000, '2026-12-01', 6), o(4, null, null, null)];

  it('по умолчанию — порядок сервера как есть', () => {
    expect(sortRouteOffers(server, 'order').map((x) => x.tourId)).toEqual([1, 2, 3, 4]);
  });
  it('цена: дешевле выше, равные — порядком сервера, цены нет — в конце', () => {
    expect(sortRouteOffers(server, 'price').map((x) => x.tourId)).toEqual([2, 3, 1, 4]);
  });
  it('дата и места: незнание — в конце, а не «раньше всех» или «ноль мест»', () => {
    expect(sortRouteOffers(server, 'date').map((x) => x.tourId)).toEqual([1, 3, 2, 4]);
    expect(sortRouteOffers(server, 'slots').map((x) => x.tourId)).toEqual([3, 1, 2, 4]);
  });

  it('полоса выбора: по умолчанию «Сначала со свободными местами», рейтинга нет, подпись правила и выбора', () => {
    const onChange = vi.fn();
    render(<RouteOfferSortBar sortBy="order" onChange={onChange} />);
    const group = screen.getByRole('group', { name: 'Порядок туров' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Сначала со свободными местами', 'Цена', 'Дата', 'Места']);
    expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true');
    for (const b of buttons) expect(b.className).toMatch(/min-h-\[44px\]/);
    expect(screen.queryByRole('button', { name: /Рейтинг/ })).toBeNull();
    const note = screen.getByText(OFFER_ORDER_NOTE.ru);
    expect(note.textContent).toMatch(/Место в списке не продаётся\.$/);
    expect(screen.getByText(SORT_CHOICE_NOTE_RU)).toBeInTheDocument();
    fireEvent.click(buttons[1]!);
    expect(onChange).toHaveBeenCalledWith('price');
  });
});
