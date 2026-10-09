/**
 * Сторож: compose_trip считает цену туров правилом брони (#2304, шаг 1в).
 *
 * До 09.10 подбор отсекал туры условием «base_price <= бюджет на человека»
 * и считал итог как base_price × группа. Тур «Камчатской рыбалки» за группу
 * (196 000 ₽ за неделю) стоил группе из четырёх 784 000 ₽ и выпадал из
 * бюджета; тур «за день» стоил как однодневный; ступени цены «Края Вулканов»
 * не учитывались, и паре туристов подбор называл сумму, которую оператор не
 * называет. Ответ инструмента писал цену группы под ключом price_per_person.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Row {
  id: number; slug: string | null; title: string; activity_type: string; base_price: number;
  price_unit: string; max_participants: number; multi_day_count: number | null; duration_hours: number | null;
  operator_name: string; location: string | null; difficulty: string | null; tour_image: string | null;
}
let ROWS: Row[] = [];
let TIERS: Record<string, Array<{ min_people: number; max_people: number | null; price_per_person: string }>> = {};

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM operator_tours t')) return { rows: ROWS };
      if (sql.includes('FROM tour_price_tiers')) return { rows: TIERS[String(params[0])] ?? [] };
      return { rows: [] };
    }),
  },
}));
vi.mock('@/lib/ai/providers', () => ({ callAIFast: vi.fn(async () => '') }));

import { composeTrip } from '@/lib/planner/compose';

const tour = (over: Partial<Row>): Row => ({
  id: 1, slug: null, title: 'Тур', activity_type: 'fishing', base_price: 10000, price_unit: 'per_person',
  max_participants: 10, multi_day_count: null, duration_hours: 8, operator_name: 'Оператор',
  location: null, difficulty: null, tour_image: null, ...over,
});

beforeEach(() => { ROWS = []; TIERS = {}; });

describe('compose_trip: сумма тура на группу — правилом брони', () => {
  it('тур за группу — одна сумма на группу, а не × людей, и проходит в бюджет', async () => {
    ROWS = [tour({ id: 11, title: 'Недельный рыболовный тур', base_price: 196000, price_unit: 'per_tour', max_participants: 8, multi_day_count: 7, duration_hours: 168 })];
    const trip = await composeTrip({ total_days: 9, budget_total: 250000, interests: ['fishing'], month: 8, group_size: 4 });
    expect(trip, 'тур за группу выпал из бюджета 250 000 на четверых').not.toBeNull();
    expect(trip!.tours[0]!.group_cost).toBe(196000);
    expect(trip!.total_price).toBe(196000);
    expect(trip!.tours[0]!.duration_days).toBe(7);
  });

  it('за день на человека — на каждый день тура и каждого', async () => {
    ROWS = [tour({ id: 5, base_price: 28000, price_unit: 'per_day_per_person', multi_day_count: 3, duration_hours: null })];
    const trip = await composeTrip({ total_days: 5, budget_total: 500000, interests: ['fishing'], month: 8, group_size: 2 });
    expect(trip!.tours[0]!.group_cost).toBe(28000 * 3 * 2);
  });

  it('за человека — на каждого', async () => {
    ROWS = [tour({ id: 27, activity_type: 'rafting', base_price: 13000 })];
    const trip = await composeTrip({ total_days: 3, budget_total: 100000, interests: ['rafting'], month: 7, group_size: 3 });
    expect(trip!.tours[0]!.group_cost).toBe(39000);
  });

  it('группа вне ступеней оператора — тур не в подборе и назван', async () => {
    ROWS = [
      tour({ id: 41, activity_type: 'trekking', title: 'Вулкан Плоский Толбачик', base_price: 60000, multi_day_count: 4 }),
      tour({ id: 27, activity_type: 'rafting', title: 'Сплав', base_price: 13000 }),
    ];
    TIERS = { '41': [{ min_people: 10, max_people: null, price_per_person: '60000' }] };
    const trip = await composeTrip({ total_days: 7, budget_total: 500000, interests: ['trekking', 'rafting'], month: 7, group_size: 2 });
    expect(trip!.tours.map((t) => t.id)).toEqual([27]);
    expect(trip!.unpriced).toEqual(['Вулкан Плоский Толбачик']);
    expect(trip!.summary).toMatch(/Без цены для группы из 2 чел\. \(цену называет оператор\): «Вулкан Плоский Толбачик»/);
  });

  it('группа внутри ступени — цена ступени', async () => {
    ROWS = [tour({ id: 48, activity_type: 'rafting', base_price: 140000, multi_day_count: 8 })];
    TIERS = { '48': [
      { min_people: 6, max_people: 8, price_per_person: '140000' },
      { min_people: 9, max_people: null, price_per_person: '115000' },
    ] };
    const trip = await composeTrip({ total_days: 10, budget_total: 2_000_000, interests: ['rafting'], month: 7, group_size: 10 });
    expect(trip!.tours[0]!.group_cost).toBe(115000 * 10);
  });
});

describe('ответ инструмента называет единицу цены', () => {
  it('нет «price_per_person» с ценой группы; есть цена с единицей и сумма на группу', () => {
    const src = readFileSync(join(process.cwd(), 'lib/agents/sdk/tourist-tools.ts'), 'utf-8');
    const block = src.slice(src.indexOf("name: 'compose_trip'"), src.indexOf('// ── Export full toolkit'));
    expect(block).not.toMatch(/price_per_person: `\$\{t\.base_price/);
    expect(block).toMatch(/price: priceFromUnit\(t\.base_price, t\.price_unit\)/);
    expect(block).toMatch(/for_group:/);
    expect(block).toMatch(/unpriced_for_group/);
  });
});
