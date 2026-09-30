/**
 * «Сегодня» у MCP — по Камчатке, а не по UTC (проверка MCP 29.09).
 *
 * Живая проба в 22:05 UTC 29.09 (на Камчатке уже 10:05 30.09) получила от
 * get_tour_availability «29.09: свободно 12», а заявка на бронь на эту дату
 * прошла бы проверку «дата уже прошла»: оба места брали UTC-дату. Даты туров
 * местные (UTC+12), поэтому полсуток каждый день инструмент предлагал
 * вчерашний день.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const query = vi.fn();
const fetchAvailabilityForTour = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('@/lib/planner', () => ({
  createPlannerCache: () => ({}),
  fetchAvailabilityForTour: (...a: unknown[]) => fetchAvailabilityForTour(...a),
}));

import { getTourAvailabilityForKuzmich } from '@/lib/kuzmich/tour-availability-tool';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-29T22:05:00Z'));
  query.mockReset().mockResolvedValue({ rows: [{ id: 27, title: 'Сплав по реке Быстрая', base_price: 13000, price_unit: 'person' }] });
  fetchAvailabilityForTour.mockReset();
});
afterEach(() => vi.useRealTimers());

const slot = (date: string) => ({ date, remaining: 12, priceOverride: null });

describe('get_tour_availability считает день по Камчатке', () => {
  it('в 22:05 UTC окно начинается с 30.09 — вчерашнего дня в ответе нет', async () => {
    fetchAvailabilityForTour.mockResolvedValue([slot('2026-09-30')]);
    const text = await getTourAvailabilityForKuzmich({ tour: '27' });
    expect(fetchAvailabilityForTour.mock.calls[0]?.[1]).toBe('2026-09-30');
    expect(text).not.toMatch(/29\.09/);
    expect(text).toMatch(/Данные на 30\.09 \(по Камчатке\)/);
  });

  it('прошедшая date_from и окно больше 31 дня поправляются вслух', async () => {
    fetchAvailabilityForTour.mockResolvedValue([slot('2026-09-30')]);
    const text = await getTourAvailabilityForKuzmich({ tour: '27', date_from: '2026-09-29', days: '999' });
    expect(fetchAvailabilityForTour.mock.calls[0]?.[1]).toBe('2026-09-30');
    expect(fetchAvailabilityForTour.mock.calls[0]?.[2]).toBe('2026-10-30');
    expect(text).toMatch(/уже прошла — показываю с сегодняшнего дня по Камчатке/);
    expect(text).toMatch(/больше 31 дня не смотрю/);
  });

  it('обрезанный список говорит, сколько дат не показано', async () => {
    const dates = Array.from({ length: 14 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
    fetchAvailabilityForTour.mockResolvedValue(dates.map(slot));
    const text = await getTourAvailabilityForKuzmich({ tour: '27', date_from: '2026-10-01' });
    expect(text).toMatch(/…и ещё 2 дат с местами/);
  });

  it('отказ занятости — честный текст и строка в логе', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchAvailabilityForTour.mockRejectedValue(Object.assign(new Error('down'), { code: '57P01' }));
    const text = await getTourAvailabilityForKuzmich({ tour: '27' });
    expect(text).toMatch(/Занятость временно недоступна/);
    expect(err).toHaveBeenCalled();
  });
});

describe('заявка на бронь через MCP судит «прошло» тоже по Камчатке', () => {
  it('роут берёт kamchatkaToday, а не UTC-дату', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/mcp/route.ts'), 'utf-8');
    expect(src).toMatch(/const today = kamchatkaToday\(\);\s*if \(date < today\)/);
    expect(src).not.toMatch(/const today = new Date\(\)\.toISOString\(\)\.slice\(0, 10\);/);
  });
});
