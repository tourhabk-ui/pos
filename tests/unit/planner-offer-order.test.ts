/**
 * Планер — правило 1в (слово владельца 29.10): туры зоны и туры дня идут
 * порядком платформы (свободная дата по ближайшему выезду, остальные —
 * жребием дня), а не рейтингом, ценой и `RANDOM()`.
 *
 * До 29.10 туры зоны сортировались рейтингами и добивались `RANDOM()`: план на
 * одних и тех же данных менялся от запроса к запросу. Проверяется вызовом
 * функций на строках «из базы».
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

const poolQuery = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));

import { fetchRealToursForZone, createPlannerCache } from '@/lib/planner/data';
import { GET as toursForDay } from '@/app/api/planner/tours-for-day/route';
import { orderComposeCandidates } from '@/lib/planner/compose';
import { orderOffers } from '@/lib/tours/offer-order';

const NEAREST: Record<string, string | null> = { '1': null, '2': '2026-11-20', '3': null, '4': '2026-11-03', '5': null, '6': null, '7': null, '8': null };
const IDS = [1, 2, 3, 4, 5, 6, 7, 8];
const rule = (ids: number[]) =>
  orderOffers(ids.map((id) => ({ id: String(id), nearestFreeDate: NEAREST[String(id)] ?? null }))).map((o) => String(o.id));

const zoneRow = (id: number) => ({
  tour_id: String(id), title: `Тур ${id}`, short_description: null, nearest_free_date: NEAREST[String(id)] ?? null,
  base_price: '10000', price_unit: 'per_person', max_participants: 10, min_participants: 1, duration_hours: 8,
  multi_day_count: null, difficulty: null, weather_dependent: false, season_start: null, season_end: null,
  lat: 53.1, lng: 158.6, zone: 'avachinsky', activity_type: 'trekking', included: null,
  tour_rating: String(5 - id / 10), tour_review_count: String(id), operator_name: `Компания ${id}`, operator_slug: `c${id}`,
  operator_rating: String(id), operator_review_count: '0', operator_verified: false,
});

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-29T03:00:00Z')); });
afterEach(() => { vi.useRealTimers(); poolQuery.mockReset(); vi.restoreAllMocks(); });

describe('туры зоны (fetchRealToursForZone)', () => {
  it('порядок — правило 1в, потолок отрезается после порядка; в SQL нет RANDOM, ORDER BY и LIMIT', async () => {
    poolQuery.mockResolvedValue({ rows: IDS.map(zoneRow) });
    const out = await fetchRealToursForZone('avachinsky', 'trekking', 3, createPlannerCache());
    expect(out!.map((t) => t.tourId)).toEqual(rule(IDS).slice(0, 3));
    expect(out!.slice(0, 2).map((t) => t.tourId)).toEqual(['4', '2']);
    const sql = String(poolQuery.mock.calls[0]![0]);
    expect(sql).not.toMatch(/RANDOM\(\)/i);
    expect(sql).not.toMatch(/ORDER BY\s+COALESCE|LIMIT \$3/);
    expect(poolQuery.mock.calls[0]![1]).toHaveLength(2);
  });

  it('два вызова на одних данных — один и тот же результат, и порядок строк выборки не важен', async () => {
    poolQuery.mockResolvedValue({ rows: IDS.map(zoneRow) });
    const a = await fetchRealToursForZone('avachinsky', 'trekking', 5, createPlannerCache());
    poolQuery.mockResolvedValue({ rows: [...IDS].reverse().map(zoneRow) });
    const b = await fetchRealToursForZone('avachinsky', 'trekking', 5, createPlannerCache());
    expect(b!.map((t) => t.tourId)).toEqual(a!.map((t) => t.tourId));
  });

  it('рейтинг тура и компании на порядок не влияет', async () => {
    poolQuery.mockResolvedValue({ rows: IDS.map((id) => ({ ...zoneRow(id), tour_rating: id === 8 ? '5' : null, operator_rating: id === 8 ? '5' : '0' })) });
    const out = await fetchRealToursForZone('avachinsky', 'trekking', 8, createPlannerCache());
    expect(out!.map((t) => t.tourId)).toEqual(rule(IDS));
  });
});

describe('туры дня (GET /api/planner/tours-for-day)', () => {
  const dayRow = (id: number) => ({
    id: String(id), slug: null, title: `Тур ${id}`, short_description: null, base_price: String(1000 * id),
    price_unit: 'per_person', duration_hours: 8, tour_image: null, operator_name: `Компания ${id}`, operator_slug: `c${id}`,
    nearest_free_date: NEAREST[String(id)] ?? null,
  });
  const req = (q: string) => ({ nextUrl: new URL(`http://x/api/planner/tours-for-day?${q}`) }) as unknown as NextRequest;

  it('порядок — правило, не «рейтинг, потом дешевле»; limit — после порядка', async () => {
    poolQuery.mockResolvedValue({ rows: IDS.map(dayRow) });
    const res = await toursForDay(req('activity_type=trekking&limit=4'));
    const json = await res.json() as { tours: { id: string }[] };
    expect(json.tours.map((t) => t.id)).toEqual(rule(IDS).slice(0, 4));
    // Внутри фрагмента ближайшей даты свой ORDER BY ta_nf.date LIMIT 1 — это не порядок туров.
    const sql = String(poolQuery.mock.calls[0]![0]);
    expect(sql).not.toMatch(/ORDER BY ot\.|LIMIT \$/);
  });

  it('зона без туров — общий список тем же правилом', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: IDS.map(dayRow) });
    const res = await toursForDay(req('activity_type=trekking&zone=western&limit=2'));
    const json = await res.json() as { tours: { id: string }[] };
    expect(json.tours.map((t) => t.id)).toEqual(rule(IDS).slice(0, 2));
  });

  it('отказ базы — 500 и SQLSTATE в лог, а не «туров нет»', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    poolQuery.mockRejectedValue(Object.assign(new Error('boom'), { code: '57014' }));
    const res = await toursForDay(req('activity_type=trekking'));
    expect(res.status).toBe(500);
    expect(err.mock.calls.flat().map((x) => JSON.stringify(x)).join(' ')).toMatch(/57014/);
  });
});

describe('compose_trip: кандидаты вида', () => {
  it('виды — группами в порядке выборки, внутри вида — правило; цена не участвует', () => {
    const it = (id: number, act: string, cost: number) => ({ row: { id, activity_type: act, nearest_free_date: NEAREST[String(id)] ?? null }, cost });
    const items = [it(1, 'fishing', 1), it(2, 'fishing', 900), it(3, 'rafting', 5), it(4, 'rafting', 800), it(5, 'fishing', 2)];
    const out = orderComposeCandidates(items, '2026-10-29').map((x) => x.row.id);
    const fishing = rule([1, 2, 5]).map(Number);
    const rafting = rule([3, 4]).map(Number);
    expect(out).toEqual([...fishing, ...rafting]);
    expect(out[0]).toBe(2);
  });
});
