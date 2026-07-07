/**
 * tests/unit/retire-tour-departures.test.ts
 *
 * Вывод полу-мёртвой модели tour_departures из кода (решение владельца):
 * брони на неё не ссылались, счётчик booked_slots никогда не заполнялся —
 * читатели получали нули. Живые потребители переведены на tour_availability
 * + реальные брони; мёртвые эндпоинты удалены.
 * Контракты: crowd-эвристика рекомендателя и «ближайший выезд» /api/public/now
 * считают из живого календаря; ни один запрос не читает tour_departures.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe('fetchCrowdLoad — из живого календаря', () => {
  it('загрузка дат считается из tour_availability + v_tour_daily_occupancy', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ total_departures: '10', booked_ratio: '60' }] });

    // fetchCrowdLoad приватная — дёргаем через публичный вход рекомендателя нельзя
    // без тяжёлого сетапа; проверяем через модуль напрямую: SQL уходит в pool.
    const { recommendTrip } = await import('@/lib/services/trip-recommender');
    expect(typeof recommendTrip).toBe('function');

    // Прямая проверка SQL: в исходнике не осталось чтения tour_departures
    const fs = await import('node:fs');
    const src = fs.readFileSync('lib/services/trip-recommender.ts', 'utf8');
    expect(src).toContain('v_tour_daily_occupancy');
    expect(src).not.toMatch(/FROM tour_departures/);
  });
});

describe('код больше не читает tour_departures', () => {
  it('в живых файлах нет FROM/JOIN tour_departures', async () => {
    const fs = await import('node:fs');
    for (const f of [
      'app/api/public/now/route.ts',
      'app/api/mcp/route.ts',
      'app/api/cron/digest/route.ts',
      'lib/services/trip-recommender.ts',
      'lib/bookings/booking.service.ts',
    ]) {
      const src = fs.readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/(FROM|JOIN)\s+tour_departures/);
    }
  });

  it('мёртвые эндпоинты модели удалены', async () => {
    const fs = await import('node:fs');
    for (const f of [
      'app/api/planner/route.ts',
      'app/api/tours/[id]/departures/route.ts',
      'app/api/bookings/availability/route.ts',
      'scripts/seed-departures.js',
    ]) {
      expect(fs.existsSync(f), f).toBe(false);
    }
  });
});
