/**
 * Личные рекомендации туров — правило 1в в ничьей (слово владельца 29.10).
 *
 * Балл совпадения с историей туриста — релевантность и остаётся первым
 * ключом. Ничья — правило платформы (свободная дата по ближайшему выезду,
 * остальные — жребием дня), а не рейтинг тура. Туриста без истории встречают
 * туры по правилу, а не «топ по рейтингу» с подписью «Рекомендуем».
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const dbQuery = vi.hoisted(() => vi.fn());
const poolQuery = vi.hoisted(() => vi.fn());
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => dbQuery(...a) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));

import { getRecommendations, orderByScoreThenRule } from '@/lib/search/tour-recommend';
import { orderOffers } from '@/lib/tours/offer-order';

const DAY = '2026-10-29';
const NEAREST: Record<string, string | null> = { '1': null, '2': null, '3': '2026-11-12', '4': null, '5': null, '6': null, '7': null };

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-29T03:00:00Z')); });
afterEach(() => { vi.useRealTimers(); dbQuery.mockReset(); poolQuery.mockReset(); });

describe('orderByScoreThenRule', () => {
  it('балл выше — выше; равный балл — правилом 1в, рейтинг не участвует', () => {
    const rows = [
      { id: '1', match_score: 3, rating: 5 },
      { id: '2', match_score: 5, rating: 1 },
      { id: '3', match_score: 3, rating: 0 },
      { id: '4', match_score: 3, rating: 4.9 },
    ];
    const dates = new Map(Object.entries(NEAREST));
    const out = orderByScoreThenRule(rows, dates, DAY).map((r) => r.id);
    expect(out[0]).toBe('2');
    expect(out[1]).toBe('3'); // ничья по баллу: тур со свободной датой — первым
    expect(out.slice(2)).toEqual(orderOffers([{ id: '1', nearestFreeDate: null }, { id: '4', nearestFreeDate: null }], { day: DAY }).map((r) => String(r.id)));
  });
});

describe('getRecommendations без истории', () => {
  it('туры витрины по правилу 1в, без ORDER BY rating и LIMIT в SQL, подпись не «Рекомендуем»', async () => {
    const ids = ['1', '2', '3', '4', '5', '6', '7'];
    dbQuery.mockImplementation(async (sql: string) => {
      if (/FROM operator_bookings/.test(sql)) return { rows: [] };
      // Эко-стратегия: колонки eco_points_reward в схеме нет, на проде она пуста.
      if (/eco_points_reward/.test(sql)) return { rows: [] };
      if (/FROM operator_tours/.test(sql)) {
        return { rows: ids.map((id) => ({ id, slug: null, title: `Тур ${id}`, description: '', price: 1000, rating: Number(id) })) };
      }
      return { rows: [] };
    });
    poolQuery.mockImplementation(async (_sql: string, params?: unknown[]) => ({
      rows: ((params?.[0] as string[]) ?? []).map((id) => ({ id, nearest_free_date: NEAREST[id] ?? null })),
    }));
    const recs = await getRecommendations('u-1', 4);
    const expected = orderOffers(ids.map((id) => ({ id, nearestFreeDate: NEAREST[id] ?? null })), { day: DAY }).slice(0, 4).map((r) => String(r.id));
    expect(recs.map((r) => r.id)).toEqual(expected);
    expect(recs[0]!.id).toBe('3');
    expect(recs.every((r) => !/Рекомендуем/.test(r.strategyLabel))).toBe(true);
    expect(recs.some((r) => 'match_score' in r)).toBe(false);
    const fallbackSql = String(dbQuery.mock.calls.find(([s]) => /FROM operator_tours/.test(String(s)) && !/eco_points_reward/.test(String(s)))![0]);
    expect(fallbackSql).not.toMatch(/ORDER BY|LIMIT/);
  });
});
