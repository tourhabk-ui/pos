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

import { getTourAvailabilityForKuzmich, yearAhead } from '@/lib/kuzmich/tour-availability-tool';

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

/**
 * Окно пусто, а расписание у тура есть (ловушка MCP 29.10, availability-nearest):
 * тур 79 отвечал «свободных мест с 29.10 по 11.11 нет … другой тур», а get_tours
 * в ту же минуту называл его «Ближайшая дата: 19 июля». Ответ обязан назвать
 * ближайшую дату тем же движком (fetchAvailabilityForTour), с числом людей —
 * дату, где мест хватит на всех, и при отказе поиска сказать «не смог».
 */
describe('пустое окно у тура с расписанием называет ближайшую свободную дату', () => {
  const TOUR = { id: 27, title: 'Сплав по реке Быстрая', base_price: 13000, price_unit: 'person' };
  beforeEach(() => {
    // Расписание у тура есть: keepsScheduleSql отвечает true, остальное — строка тура.
    query.mockReset().mockImplementation(async (sql: string) => (/ta_sched/.test(sql) ? { rows: [{ has: true }] } : { rows: [TOUR] }));
  });
  const free = (date: string, remaining: number) => ({ date, remaining, priceOverride: null });

  it('после окна: старт — следующий день после окна, горизонт — год; дата названа, «другой тур» — нет', async () => {
    fetchAvailabilityForTour.mockResolvedValueOnce([]).mockResolvedValueOnce([free('2027-07-19', 12)]);
    const text = await getTourAvailabilityForKuzmich({ tour: '27' });
    expect(fetchAvailabilityForTour).toHaveBeenCalledTimes(2);
    expect(fetchAvailabilityForTour.mock.calls[0].slice(0, 3)).toEqual(['27', '2026-09-30', '2026-10-13']);
    expect(fetchAvailabilityForTour.mock.calls[1].slice(0, 3)).toEqual(['27', '2026-10-14', '2027-09-30']);
    expect(text).toMatch(/свободных мест с 30\.09 по 13\.10 нет/);
    expect(text).toContain('Ближайшая свободная дата после этого окна — 19.07.2027, свободно 12');
    expect(text).toContain('date_from=2027-07-19');
    expect(text).not.toMatch(/другой тур/);
    // Дата соседа — не строка слота: сверка каналов не примет её за дату окна.
    expect(text).not.toMatch(/^-\s+\d{2}\.\d{2}\s+\(/m);
  });

  it('с числом людей — первая дата, где мест хватит на всех, а не первая с местами', async () => {
    fetchAvailabilityForTour.mockResolvedValueOnce([]).mockResolvedValueOnce([free('2027-07-19', 2), free('2027-07-26', 5)]);
    const text = await getTourAvailabilityForKuzmich({ tour: '27', people: '4' });
    expect(text).toContain('Ближайшая дата после этого окна, где хватит мест на 4 чел., — 26.07.2027, свободно 5');
    expect(text).not.toMatch(/19\.07/);
  });

  it('поиск за окном не прочитался — «не смог», а не «дат нет» и не общий отказ; строка в логе', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchAvailabilityForTour.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('Не удалось проверить занятость тура — попробуйте позже.'));
    const text = await getTourAvailabilityForKuzmich({ tour: '27' });
    expect(text).toMatch(/свободных мест с 30\.09 по 13\.10 нет/);
    expect(text).toMatch(/после этого окна проверить не смог — не говори, что дат нет/);
    expect(text).not.toMatch(/Занятость временно недоступна/);
    expect(text).not.toMatch(/свободных дат нет/);
    expect(err.mock.calls.map((c) => String(c[0]))).toContain('[tour-availability] ближайшая дата вне окна не прочитана');
    err.mockRestore();
  });

  it('пусто и после окна — «до <горизонт> нет» и совет другого тура; слова «вовсе» нет', async () => {
    fetchAvailabilityForTour.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const text = await getTourAvailabilityForKuzmich({ tour: '27' });
    expect(text).toContain('После этого окна до 30.09.2027 свободных дат нет');
    expect(text).toMatch(/предложи другой тур/);
    expect(text).not.toMatch(/вовсе/);
  });

  it('окно в будущем: свободная дата раньше окна названа, и «другой тур» не советуется', async () => {
    fetchAvailabilityForTour
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([free('2026-10-05', 3)])
      .mockResolvedValueOnce([]);
    const text = await getTourAvailabilityForKuzmich({ tour: '27', date_from: '2026-11-10', days: '3' });
    expect(fetchAvailabilityForTour.mock.calls[1].slice(0, 3)).toEqual(['27', '2026-09-30', '2026-11-09']);
    expect(fetchAvailabilityForTour.mock.calls[2].slice(0, 3)).toEqual(['27', '2026-11-13', '2027-09-30']);
    expect(text).toContain('Раньше этого окна есть свободная дата — 05.10, свободно 3');
    expect(text).toContain('После этого окна до 30.09.2027 свободных дат нет');
    expect(text).not.toMatch(/другой тур/);
  });

  it('окно дальше года — так и сказано; раньше окна смотрим только до горизонта', async () => {
    fetchAvailabilityForTour.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const text = await getTourAvailabilityForKuzmich({ tour: '27', date_from: '2027-10-05', days: '14' });
    expect(fetchAvailabilityForTour).toHaveBeenCalledTimes(2);
    expect(fetchAvailabilityForTour.mock.calls[1].slice(0, 3)).toEqual(['27', '2026-09-30', '2027-09-30']);
    expect(text).toContain('Дальше года от сегодняшнего дня (после 30.09.2027) не смотрю');
    expect(text).toContain('Раньше этого окна, с 30.09 по 30.09.2027, свободных дат тоже нет');
  });

  it('горизонт — тот же день через год; 29.02 даёт 28.02, как INTERVAL \'1 year\'', () => {
    expect(yearAhead('2026-09-30')).toBe('2027-09-30');
    expect(yearAhead('2028-02-29')).toBe('2029-02-28');
    // Через 29.02 «+365 дней» отстал бы на день: 2027-03-01 + 365 = 2028-02-29.
    expect(yearAhead('2027-03-01')).toBe('2028-03-01');
  });
});

describe('заявка на бронь через MCP судит «прошло» тоже по Камчатке', () => {
  it('роут берёт kamchatkaToday, а не UTC-дату', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/mcp/route.ts'), 'utf-8');
    expect(src).toMatch(/const today = kamchatkaToday\(\);\s*if \(date < today\)/);
    expect(src).not.toMatch(/const today = new Date\(\)\.toISOString\(\)\.slice\(0, 10\);/);
  });
});
