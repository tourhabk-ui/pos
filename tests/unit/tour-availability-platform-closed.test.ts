/**
 * get_tour_availability называет даты, которые закрыл Ведар (этап 6, 1435).
 *
 * Занятость отвечает на такую дату «мест нет» наравне с разобранной. Агент
 * пересказывал это как отказ и до заявки не доходил, хотя оператора никто не
 * спрашивал. Ответ обязан сказать, кто закрыл и что заявку отправить можно.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const query = vi.fn();
const fetchAvailabilityForTour = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('@/lib/planner', () => ({
  createPlannerCache: () => ({}),
  fetchAvailabilityForTour: (...a: unknown[]) => fetchAvailabilityForTour(...a),
}));

import { getTourAvailabilityForKuzmich } from '@/lib/kuzmich/tour-availability-tool';
import { DATES_CLOSED_BY_PLATFORM_SQL } from '@/lib/tours/date-closure';

const TOUR = { id: 27, title: 'Каньон Опасный', base_price: 13000, price_unit: 'person' };
let closed: string[] | Error = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-20T00:05:00Z'));
  closed = [];
  fetchAvailabilityForTour.mockReset();
  query.mockReset().mockImplementation(async (sql: string) => {
    if (sql === DATES_CLOSED_BY_PLATFORM_SQL) {
      if (closed instanceof Error) throw closed;
      return { rows: closed.map((date) => ({ date })) };
    }
    return /ta_sched/.test(sql) ? { rows: [{ has: true }] } : { rows: [TOUR] };
  });
});
afterEach(() => vi.useRealTimers());

const free = (date: string, remaining: number) => ({ date, remaining, priceOverride: null });
const closedLine = (text: string) => text.split('\n').find((l) => l.includes('закрыл Ведар')) ?? null;

describe('даты, закрытые Ведаром, названы', () => {
  it('окно пустое и целиком закрыто Ведаром: сказано кто закрыл, что это не отказ оператора и что заявку отправить можно', async () => {
    closed = ['2026-12-01', '2026-12-02', '2026-12-03'];
    fetchAvailabilityForTour.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([free('2027-05-01', 8)]);
    const text = await getTourAvailabilityForKuzmich({ tour: '27', date_from: '2026-12-01', days: '3' });
    expect(text).toMatch(/свободных мест с 01\.12 по 03\.12 нет/);
    expect(closedLine(text)).toBe(
      'Даты с 01.12 по 03.12 в календаре закрыл Ведар по описанию тура — оператор их не закрывал и не подтверждал. '
      + 'Мест на них в системе нет, но это не отказ оператора: create_booking_request на такую дату отправит ему заявку вопросом, ходит ли он в этот день.',
    );
    // Спрошено то же окно, что и занятость.
    expect(query.mock.calls.find((c) => c[0] === DATES_CLOSED_BY_PLATFORM_SQL)?.[1]).toEqual(['27', '2026-12-01', '2026-12-03']);
    // Строка — не строка слота: сверка каналов не примет закрытую дату за свободную.
    expect(text).not.toMatch(/^-\s+0[123]\.12\s+\(/m);
  });

  it('одна дата и даты вразбивку — своими словами; длинный список обрезан с числом остальных', async () => {
    fetchAvailabilityForTour.mockResolvedValue([]);
    closed = ['2026-12-05'];
    expect(closedLine(await getTourAvailabilityForKuzmich({ tour: '27', date_from: '2026-12-01', days: '14' })))
      .toMatch(/^Дату 05\.12 в календаре закрыл Ведар по описанию тура — оператор её не закрывал и не подтверждал\. Мест на неё в системе нет/);
    closed = ['2026-12-01', '2026-12-03', '2026-12-05', '2026-12-07', '2026-12-09', '2026-12-11', '2026-12-13'];
    expect(closedLine(await getTourAvailabilityForKuzmich({ tour: '27', date_from: '2026-12-01', days: '14' })))
      .toMatch(/^Даты 01\.12, 03\.12, 05\.12, 07\.12, 09\.12 и ещё 2 в календаре закрыл Ведар/);
    // Окно через Новый год: у дат следующего года назван год.
    closed = ['2026-12-31', '2027-01-01'];
    expect(closedLine(await getTourAvailabilityForKuzmich({ tour: '27', date_from: '2026-12-25', days: '14' })))
      .toMatch(/^Даты с 31\.12 по 01\.01\.2027 в календаре закрыл Ведар/);
  });

  it('в окне есть и свободные даты: строка о закрытых Ведаром стоит рядом со слотами', async () => {
    closed = ['2026-12-01'];
    fetchAvailabilityForTour.mockResolvedValue([free('2026-11-28', 6)]);
    const text = await getTourAvailabilityForKuzmich({ tour: '27', date_from: '2026-11-25', days: '10' });
    expect(text).toMatch(/^- 28\.11 \(2026-11-28\): свободно 6/m);
    expect(closedLine(text)).toMatch(/^Дату 01\.12 в календаре закрыл Ведар/);
  });

  it('закрытых Ведаром в окне нет или признак не прочитался — строки нет; «закрыл Ведар» по догадке не говорится', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchAvailabilityForTour.mockResolvedValue([]);
    expect(closedLine(await getTourAvailabilityForKuzmich({ tour: '27', date_from: '2026-12-01', days: '3' }))).toBeNull();
    closed = Object.assign(new Error('db'), { code: '57014' });
    const text = await getTourAvailabilityForKuzmich({ tour: '27', date_from: '2026-12-01', days: '3' });
    expect(closedLine(text)).toBeNull();
    // Сбой признака ответ о занятости не роняет.
    expect(text).toMatch(/свободных мест с 01\.12 по 03\.12 нет/);
    expect(error.mock.calls.flat().join(' ')).toMatch(/date-closure.*57014/);
    error.mockRestore();
  });
});
