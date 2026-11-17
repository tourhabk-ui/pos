/**
 * Круг по компаниям в get_tours и каталоге Кузьмича (бриф 17.11, слово
 * владельца «го»).
 *
 * Замер брифа: get_tours по «вулканам» — 56 туров на 8 страницах, и три тура
 * из четырёх первых — одного гида. Правило 1в давало билет жребия каждому
 * туру, поэтому у компании с десятью турами было десять билетов против
 * одного. Теперь внутри каждой ступени правила — по одному туру от компании
 * за круг (orderOffersByCompanyTurns), и отбор фильтра упорядочен тем же
 * кругом заново: круг по всему каталогу после фильтра рассыпается.
 *
 * Судит вызов: правило — на граничных данных, инструмент — настоящим
 * исполнителем на подменённой базе (§ «Сторож судит поведение»).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/lib/planner', () => ({}));

import { pool } from '@/lib/db-pool';
import { OFFER_ORDER_NOTE_AGENT_TURNS, orderOffersByCompanyTurns } from '@/lib/tours/offer-order';

const q = pool.query as unknown as ReturnType<typeof vi.fn>;
afterEach(() => { q.mockReset(); vi.restoreAllMocks(); });

const DAY = '2026-11-17';

type K = { id: number; nearestFreeDate: string | null; anyDayOpen: boolean | null; partnerId: string | null };
const k = (id: number, partnerId: string | null, nearestFreeDate: string | null = null, anyDayOpen: boolean | null = null): K =>
  ({ id, partnerId, nearestFreeDate, anyDayOpen });
const order = (rows: K[], day = DAY) => orderOffersByCompanyTurns(rows, (r) => r, { day });

describe('orderOffersByCompanyTurns: правило', () => {
  it('у компании с пятью турами одно место за круг: первые три — три разные компании', () => {
    const rows = [k(1, 'guide'), k(2, 'guide'), k(3, 'guide'), k(4, 'guide'), k(5, 'guide'), k(6, 'a'), k(7, 'b')];
    // Каждый день жребия, а не один удачный: круг не зависит от того, чей билет выпал.
    for (const day of ['2026-11-17', '2026-11-18', '2026-11-19', '2026-12-01', '2027-01-15']) {
      const out = order(rows, day);
      expect(new Set(out.slice(0, 3).map((r) => r.partnerId)).size).toBe(3);
      // Дальше гид идёт один: другим нечего ставить.
      expect(out.slice(3).every((r) => r.partnerId === 'guide')).toBe(true);
      expect(out).toHaveLength(7);
    }
  });

  it('ступени правила 1в не смешиваются: выезд второго тура гида раньше тура без дат', () => {
    const rows = [
      k(1, 'guide', '2026-11-20'), k(2, 'guide', '2026-11-25'),
      k(3, 'a'), k(4, 'b', null, true),
    ];
    const out = order(rows).map((r) => r.id);
    // Оба выезда гида — первыми: круг идёт внутри ступени, а не через ступени.
    expect(out.slice(0, 2).sort()).toEqual([1, 2]);
    expect(out[2]).toBe(4); // «в любой день сезона»
    expect(out[3]).toBe(3); // остальные
  });

  it('в ступени выездов компания с более ранней датой — раньше', () => {
    const out = order([k(1, 'late', '2026-12-10'), k(2, 'early', '2026-11-20'), k(3, 'early', '2026-11-21')]).map((r) => r.id);
    expect(out).toEqual([2, 1, 3]);
  });

  it('тур без компании — сам себе очередь, и вход не меняется', () => {
    const rows = [k(1, null), k(2, null), k(3, ''), k(4, 'a')];
    const copy = rows.map((r) => ({ ...r }));
    const out = order(rows);
    expect(out.map((r) => r.id).sort()).toEqual([1, 2, 3, 4]);
    expect(rows).toEqual(copy);
  });
});

/** Строка базы, как её отдаёт SELECT каталога. */
const row = (id: number, operator: string, over: Record<string, unknown> = {}) => ({
  id, title: `Тур ${id}`, base_price: 10000, price_unit: 'per_person', multi_day_count: null,
  activity_type: 'volcano', location_name: null, duration_type: null, duration_hours: null,
  season_start: null, season_end: null, available_slots: null, next_available_date: null,
  short_description: null, has_schedule: false, has_details: false,
  operator_name: `Компания ${operator}`, operator_id: `op-${operator}`,
  description: null, program_text: null, main_place_name: null, main_place_type: null,
  ...over,
});

async function getTours(rows: unknown[], args: Record<string, string>) {
  q.mockResolvedValue({ rows });
  vi.resetModules();
  const { executeKuzmichTool } = await import('@/lib/kuzmich/core');
  return executeKuzmichTool('get_tours', args, { surface: 'mcp' });
}
const companies = (s: string) => (s.match(/^ID\d+:.*$/gm) ?? []).map((l) => l.match(/Оп: (Компания \S+)/)?.[1] ?? '');

describe('get_tours: круг по компаниям настоящим исполнителем', () => {
  // Как в замере брифа: у гида туров больше, чем у всех остальных вместе.
  const catalog = [
    ...[1, 2, 3, 4, 5, 6].map((id) => row(id, 'Гид')),
    row(7, 'А'), row(8, 'Б'), row(9, 'В'),
  ];

  it('первая страница без фильтра: первые четыре — четыре разные компании', async () => {
    const out = await getTours(catalog, {});
    const first = companies(out).slice(0, 4);
    expect(first).toHaveLength(4);
    expect(new Set(first).size).toBe(4);
    expect(out).toContain(OFFER_ORDER_NOTE_AGENT_TURNS);
  });

  it('отбор по виду: круг заново по отобранным, а не остаток круга всего каталога', async () => {
    // У компании А четыре рыбалки и один вулкан: в круге всего каталога её
    // вулкан стоит в случайном круге, и после фильтра туры гида шли бы подряд.
    const mixed = [
      ...[1, 2, 3, 4, 5].map((id) => row(id, 'Гид')),
      ...[6, 7, 8, 9].map((id) => row(id, 'А', { activity_type: 'fishing' })), row(10, 'А'),
      row(11, 'Г'),
    ];
    // Несколько дней жребия: в один удачный день и старый порядок прошёл бы.
    for (const now of ['2026-11-17T03:00:00Z', '2026-11-18T03:00:00Z', '2026-11-19T03:00:00Z', '2026-11-20T03:00:00Z', '2026-11-21T03:00:00Z', '2026-11-22T03:00:00Z']) {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(now));
      const out = await getTours(mixed, { activity_type: 'volcano' });
      vi.useRealTimers();
      const list = companies(out);
      expect(list).toHaveLength(7);
      expect(new Set(list.slice(0, 3))).toEqual(new Set(['Компания Гид', 'Компания А', 'Компания Г']));
    }
  });
});
