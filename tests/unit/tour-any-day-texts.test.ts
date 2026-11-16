/**
 * Тур «в любой день сезона» (#3476 шаг 2) — что говорят Кузьмич и MCP.
 *
 * Каталог (get_tours, system-промпт Кузьмича) и ответ о датах
 * (get_tour_availability) называют слово оператора — «выезжает в любой день
 * сезона», окно сезона и кто подтверждает место, — а не «расписания в
 * системе нет». Тур без признака говорит как раньше. Вызовом настоящего
 * загрузчика на подменённой базе; ответ get_tour_availability — в
 * tests/unit/tour-request-window.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const q = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...a: unknown[]) => q.query(...a), connect: vi.fn(async () => ({ query: (...a: unknown[]) => q.query(...a), release: vi.fn() })) },
}));
vi.mock('@/lib/planner', () => ({}));

import { SERVER_INSTRUCTIONS } from '@/lib/mcp/server-instructions';
import { anyDayLine } from '@/lib/tours/schedule-kind';
import { requestWindow } from '@/lib/tours/request-window';

const row = (id: number, over: Record<string, unknown>) => ({
  id, title: `Тур ${id}`, base_price: 10000, price_unit: 'per_person', multi_day_count: null,
  activity_type: 'trekking', location_name: null, duration_type: null, duration_hours: 8,
  season_start: '2099-06-01', season_end: '2099-09-30', available_slots: null, next_available_date: null,
  short_description: null, has_schedule: false, has_details: true, operator_name: 'Тест',
  description: null, program_text: null, main_place_name: null, main_place_type: null,
  any_day_open: false,
  ...over,
});

let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { spy = vi.spyOn(console, 'error').mockImplementation(() => {}); q.query.mockReset(); });
afterEach(() => { spy.mockRestore(); });

describe('каталог Кузьмича и get_tours', () => {
  it('«любой день сезона» — слово оператора с окном; без признака — как раньше', async () => {
    q.query.mockResolvedValue({ rows: [row(1, { any_day_open: true }), row(2, {})] });
    vi.resetModules();
    const { loadTourCatalogEntries } = await import('@/lib/kuzmich/core');
    const cat = await loadTourCatalogEntries();
    const line = (id: number) => cat!.text.split('\n').find((l) => l.startsWith(`ID${id}:`)) ?? '';
    expect(line(1)).toContain('Оператор выезжает в любой день сезона (сезон 1 июня 2099 — 30 сентября 2099)');
    expect(line(1)).toContain('место и группу подтверждает он');
    expect(line(1)).not.toContain('Расписания в системе нет');
    expect(line(2)).toContain('Расписания в системе нет — только заявка оператору на дату сезона');
    expect(line(2)).toContain('это не бронь');
    expect(line(2)).not.toMatch(/предварительн\S* брон/i);
    expect(line(2)).not.toContain('любой день сезона');
  // Свежий импорт lib/kuzmich/core после resetModules под нагрузкой полного
  // прогона дольше 5 с по умолчанию (16.11: один отказ из семи прогонов).
  }, 30_000);
});

describe('правило MCP', () => {
  it('инструкция сервера называет форму «любой день сезона» и что места не обещать', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/при «Расписания в системе нет» и «любой день сезона» мест не обещай/);
  });

  it('строка одна — anyDayLine на окне сезона', () => {
    const w = requestWindow({ season_start: '2099-07-15', season_end: '2099-10-15', duration_type: null, multi_day_count: null, duration_hours: 8 }, '2099-01-01');
    if (w.kind !== 'season') throw new Error('окно не сезон');
    expect(anyDayLine(w)).toBe('Оператор выезжает в любой день сезона (сезон 15 июля 2099 — 15 октября 2099) — так он записал сам; любая дата сезона свободна для заявки, место и группу подтверждает он');
  });
});
