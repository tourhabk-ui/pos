/**
 * Жильё при уровне «эконом» — сначала дешевле на группу (#3394 п.1,
 * карт-бланш владельца 16.11).
 *
 * До этой правки уровень плана жильё не трогал вовсе: подбор шёл одним
 * порядком (проверенные, оценка, цена), а «эконом» уходил исполнителю
 * пожеланием. Классов жилья в базе нет, поэтому «эконом» значит только
 * порядок: дешевле на группу за все ночи — раньше, цена рядом, и правило
 * порядка сказано словами (§0). Объект «эконом-жильём» не называется.
 *
 * Проверяется поведением:
 *  - правило порядка — вызовом на граничных данных;
 *  - подбор — вызовом с подменённой базой: какой запрос, сколько кандидатов,
 *    что вернулось и в каком порядке;
 *  - роут планера и экран — вызовом и рендером;
 *  - ответ Кузьмича и ИИ-агента — вызовом make_trip_plan по MCP.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextRequest } from 'next/server';

vi.mock('@/lib/planner/require-session', () => ({ plannerSession: vi.fn(async () => ({ userId: 'u-planner' })) }));
const { poolQuery } = vi.hoisted(() => ({ poolQuery: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...a: unknown[]) => poolQuery(...a), connect: vi.fn(async () => ({ query: poolQuery, release: vi.fn() })) },
}));

import {
  cheapestFirst, lodgingOrderFor, LODGING_ORDER_NOTE_RU, PLAN_LODGING_ORDER_NOTE_RU, LODGING_OPTIONS_PER_STAY,
  type StayPrice,
} from '@/lib/planner/trip-extras';
import {
  findLodgingForStay, findRequestLodgingForStay,
  LODGING_FOR_STAY_SQL, LODGING_CHEAPEST_CANDIDATES_SQL, LODGING_CHEAPEST_POOL,
  REQUEST_LODGING_FOR_STAY_SQL, REQUEST_LODGING_CHEAPEST_SQL,
} from '@/lib/planner/trip-extras-data';
import { formatPlanOffers, type PlanOffers } from '@/lib/kuzmich/plan-offers';
import { TripExtrasSection } from '@/app/planner/TripExtrasSection';
import type { TripExtrasData } from '@/app/planner/planner-types';

const STAY = { zone: 'avachinsky' as const, checkIn: '2030-08-03', checkOut: '2030-08-05', nights: 2 };

const priced = (total: number): StayPrice => ({ kind: 'priced', total, rooms: 1, roomId: 'r', roomName: 'Номер', maxGuests: 4 });
const noFit: StayPrice = { kind: 'no_fit', people: 4 };

beforeEach(() => { poolQuery.mockReset(); });
afterEach(() => { cleanup(); });

describe('правило порядка', () => {
  it('«эконом» — дешевле первым; «комфорт», «премиум» и уровень не назван — прежний порядок', () => {
    expect(lodgingOrderFor('economy')).toBe('cheapest');
    expect(lodgingOrderFor('comfort')).toBe('default');
    expect(lodgingOrderFor('premium')).toBe('default');
    expect(lodgingOrderFor(undefined)).toBe('default');
    expect(lodgingOrderFor(null)).toBe('default');
  });

  it('цена на группу — первым ключом; где её нет — после, по цене за ночь; цены нет вовсе — в конце; ничья — по имени', () => {
    const items = [
      { name: 'Без цены', priceFrom: null, stay: noFit },
      { name: 'Номера дешёвые, группа дорогая', priceFrom: 2000, stay: priced(18000) },
      { name: 'Семейный', priceFrom: 3000, stay: priced(9000) },
      { name: 'Не помещается', priceFrom: 2500, stay: noFit },
      { name: 'Берёза', priceFrom: 3000, stay: priced(9000) },
    ];
    expect(cheapestFirst(items).map((x) => x.name)).toEqual([
      'Берёза', 'Семейный', 'Номера дешёвые, группа дорогая', 'Не помещается', 'Без цены',
    ]);
    // Вход не меняется: порядок — новая выдача.
    expect(items[0]!.name).toBe('Без цены');
  });
});

describe('подбор жилья: запрос и порядок', () => {
  const row = (id: string, name: string, priceFrom: string | null, rooms: unknown[]) => ({
    id, name, type: 'guesthouse', price_from: priceFrom, rating: null, review_count: 0, is_verified: id === 'a1', rooms,
  });
  // Строки — в порядке запроса «по цене за ночь»: дешёвый номер на двоих
  // группе из четырёх обходится дороже семейного.
  const ROWS = [
    row('a1', 'Двушки', '2000.00', [{ room_id: 'r1', name: 'На двоих', max_guests: 2, min_free: 5, stay_sum: 4000 }]),
    row('a2', 'Семейный', '3000.00', [{ room_id: 'r2', name: 'Семейный', max_guests: 4, min_free: 1, stay_sum: 6000 }]),
    row('a3', 'Тесно', '3500.00', [{ room_id: 'r3', name: 'Малый', max_guests: 2, min_free: 1, stay_sum: 7000 }]),
    row('a4', 'Хостел', '1500.00', [{ room_id: 'r4', name: 'Койка', max_guests: 4, min_free: 1, stay_sum: 7000 }]),
  ];

  it('«эконом»: запрос кандидатов с запасом, порядок — по цене на группу, показано не больше трёх', async () => {
    poolQuery.mockResolvedValueOnce({ rows: ROWS });
    const r = await findLodgingForStay(STAY, 4, 'cheapest');
    expect(poolQuery.mock.calls[0]![0]).toBe(LODGING_CHEAPEST_CANDIDATES_SQL);
    expect(poolQuery.mock.calls[0]![1]).toEqual(['avachinsky', '2030-08-03', '2030-08-05', LODGING_CHEAPEST_POOL]);
    expect(r.state).toBe('ok');
    if (r.state !== 'ok') return;
    expect(r.items).toHaveLength(LODGING_OPTIONS_PER_STAY);
    // Семейный 6000 на группу, хостел 7000, двушки 2 × 4000 = 8000; «Тесно» не помещается — после.
    expect(r.items.map((i) => [i.name, i.stay.kind === 'priced' ? i.stay.total : null])).toEqual([
      ['Семейный', 6000], ['Хостел', 7000], ['Двушки', 8000],
    ]);
  });

  it('прежний порядок не тронут: запрос с тремя вариантами, строки — как отдала база', async () => {
    poolQuery.mockResolvedValueOnce({ rows: ROWS.slice(0, 3) });
    const r = await findLodgingForStay(STAY, 4);
    expect(poolQuery.mock.calls[0]![0]).toBe(LODGING_FOR_STAY_SQL);
    expect(poolQuery.mock.calls[0]![1]).toEqual(['avachinsky', '2030-08-03', '2030-08-05', LODGING_OPTIONS_PER_STAY]);
    expect(r.state === 'ok' && r.items.map((i) => i.name)).toEqual(['Двушки', 'Семейный', 'Тесно']);
  });

  it('упёрлись в запас кандидатов — не молча: строка в лог', async () => {
    const many = Array.from({ length: LODGING_CHEAPEST_POOL }, (_, i) =>
      row(`b${i}`, `Объект ${i}`, String(1000 + i), [{ room_id: `q${i}`, name: 'Номер', max_guests: 4, min_free: 1, stay_sum: 5000 + i }]));
    poolQuery.mockResolvedValueOnce({ rows: many });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await findLodgingForStay(STAY, 4, 'cheapest');
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/дешевле на группу.*запаса 60/);
    warn.mockRestore();
  });

  it('запросы: первый ключ — цена за ночь «от», отбор тот же, что у прежнего порядка', () => {
    expect(LODGING_CHEAPEST_CANDIDATES_SQL).toMatch(/ORDER BY a\.price_per_night_from ASC NULLS LAST/);
    expect(LODGING_FOR_STAY_SQL).toMatch(/ORDER BY a\.is_verified DESC, a\.rating DESC/);
    const cut = (sql: string) => sql.slice(0, sql.indexOf('ORDER BY'));
    expect(cut(LODGING_CHEAPEST_CANDIDATES_SQL)).toBe(cut(LODGING_FOR_STAY_SQL));
    expect(REQUEST_LODGING_CHEAPEST_SQL).toMatch(/ORDER BY a\.price_per_night_from ASC NULLS LAST/);
    expect(cut(REQUEST_LODGING_CHEAPEST_SQL)).toBe(cut(REQUEST_LODGING_FOR_STAY_SQL));
  });

  it('жильё по заявке хозяину при «эконом» — свой запрос по цене за ночь', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    await findRequestLodgingForStay(STAY, 'cheapest');
    await findRequestLodgingForStay(STAY);
    expect(poolQuery.mock.calls.map((c) => c[0])).toEqual([REQUEST_LODGING_CHEAPEST_SQL, REQUEST_LODGING_FOR_STAY_SQL]);
  });
});

describe('роут планера', () => {
  let ip = 0;
  async function extras(body: unknown) {
    const { POST } = await import('@/app/api/planner/trip-extras/route');
    ip += 1;
    const res = await POST(new NextRequest('http://localhost/api/planner/trip-extras', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.7.0.${ip}` }, body: JSON.stringify(body),
    }));
    return { status: res.status, json: await res.json() as { data?: { lodging?: { order?: string } } } };
  }
  const BODY = {
    needs: { lodging: true }, arrivalDate: '2030-08-03', departureDate: '2030-08-05', adults: 2,
    days: [{ day: 1, type: 'arrival', zone: 'avachinsky' }, { day: 2, type: 'rest', zone: 'avachinsky' }, { day: 3, type: 'departure', zone: 'avachinsky' }],
  };

  it('«эконом» — подбор по цене, порядок в ответе; без уровня — прежний; чужое слово — отказ', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    const eco = await extras({ ...BODY, budgetTier: 'economy' });
    expect(eco.json.data?.lodging?.order).toBe('cheapest');
    expect(poolQuery.mock.calls.some((c) => c[0] === LODGING_CHEAPEST_CANDIDATES_SQL)).toBe(true);
    poolQuery.mockClear();
    const plain = await extras(BODY);
    expect(plain.json.data?.lodging?.order).toBe('default');
    expect(poolQuery.mock.calls.some((c) => c[0] === LODGING_FOR_STAY_SQL)).toBe(true);
    expect(poolQuery.mock.calls.some((c) => c[0] === LODGING_CHEAPEST_CANDIDATES_SQL)).toBe(false);
    expect((await extras({ ...BODY, budgetTier: 'cheap' })).status).toBe(400);
  });
});

describe('экран планера: порядок словами', () => {
  const option = (id: string, name: string, total: number) => ({
    id, name, type: 'guesthouse', priceFrom: 3000, rating: null, reviewCount: 0, isVerified: false, stay: priced(total),
  });
  const data = (order: 'default' | 'cheapest' | undefined, ok = true): TripExtrasData => ({
    lodging: {
      state: 'checked', nightsInTours: 0, unzonedCount: 0, ...(order ? { order } : {}),
      stays: [{
        zone: 'avachinsky', zoneName: 'Авачинская зона', checkIn: '2030-08-03', checkOut: '2030-08-05', nights: 2,
        result: ok ? { state: 'ok', items: [option('a1', 'Семейный', 6000), option('a2', 'Хостел', 7000)] } : { state: 'empty' },
      }],
    },
  });

  it('«эконом» — правило «дешевле на группу», «Место в списке не продаётся»; цена — у каждого варианта', () => {
    render(<TripExtrasSection load={{ status: 'ready', data: data('cheapest') }} />);
    expect(screen.getByTestId('lodging-order-note').textContent).toBe(LODGING_ORDER_NOTE_RU.cheapest);
    expect(LODGING_ORDER_NOTE_RU.cheapest).toMatch(/дешевле на вашу группу за все ночи.*Место в списке не продаётся\.$/);
    expect(screen.getAllByTestId('lodging-option').map((li) => li.textContent?.replace(/\s/g, ' '))).toEqual([
      expect.stringMatching(/Семейный.*6 000 ₽/), expect.stringMatching(/Хостел.*7 000 ₽/),
    ]);
    // Объект «эконом-жильём» не называется: слово стоит только в правиле порядка.
    expect(screen.getAllByTestId('lodging-option').some((li) => /эконом/i.test(li.textContent ?? ''))).toBe(false);
  });

  it('прежний порядок назван своими словами; ответ сервера без поля — тоже прежний', () => {
    render(<TripExtrasSection load={{ status: 'ready', data: data('default') }} />);
    expect(screen.getByTestId('lodging-order-note').textContent).toBe(LODGING_ORDER_NOTE_RU.default);
    cleanup();
    render(<TripExtrasSection load={{ status: 'ready', data: data(undefined) }} />);
    expect(screen.getByTestId('lodging-order-note').textContent).toBe(LODGING_ORDER_NOTE_RU.default);
  });

  it('вариантов нет — и правила порядка нет: упорядочивать нечего', () => {
    render(<TripExtrasSection load={{ status: 'ready', data: data('cheapest', false) }} />);
    expect(screen.queryByTestId('lodging-order-note')).toBeNull();
  });
});

describe('ответ Кузьмича и ИИ-агента', () => {
  const offers = (order: PlanOffers['order'], ok = true): PlanOffers => ({
    stays: [{
      stay: STAY,
      result: ok
        ? { state: 'ok', items: [{ id: 'a1', name: 'Семейный', type: 'guesthouse', priceFrom: 3000, rating: null, reviewCount: 0, isVerified: false, stay: priced(6000) }] }
        : { state: 'empty' },
      byRequest: { state: 'empty' },
    }],
    ...(order ? { order } : {}),
    unzonedCount: 0, moreStays: 0, nightsInTours: 0, gapNights: 0,
    charter: { state: 'empty' }, rental: { state: 'empty' },
  });
  const ctx = { surface: 'mcp' as const, adults: 4, children: [], site: 'https://vedarai.ru' };

  it('правило порядка — строкой перед жильём; без вариантов — без неё', () => {
    const eco = formatPlanOffers(offers('cheapest'), ctx);
    const at = eco.indexOf(PLAN_LODGING_ORDER_NOTE_RU.cheapest);
    expect(at).toBeGreaterThan(0);
    expect(eco.findIndex((l) => l.startsWith('Жильё — '))).toBeGreaterThan(at);
    expect(formatPlanOffers(offers(undefined), ctx)).toContain(PLAN_LODGING_ORDER_NOTE_RU.default);
    const none = formatPlanOffers(offers('cheapest', false), ctx);
    expect(none.some((l) => l.startsWith('Порядок жилья'))).toBe(false);
  });
});
