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

describe('занятость планера — из живого календаря', () => {
  it('единственный читатель занятости зон — data.ts по v_tour_daily_occupancy', async () => {
    const fs = await import('node:fs');
    const data = fs.readFileSync('lib/planner/data.ts', 'utf8');
    expect(data).toContain('v_tour_daily_occupancy');
    expect(data).not.toMatch(/(FROM|JOIN)\s+tour_departures/);
  });

  it('второго, неподключённого счётчика загрузки в движке нет (#3199, E13)', async () => {
    // fetchCrowdLoad не вызывал никто, а его «~X%» — занятость×0,7 плюс
    // надбавка за число слотов, без дат — константы по месяцу сервера.
    // Подключать такое значило бы показать туристу выдуманное число.
    const fs = await import('node:fs');
    const src = fs.readFileSync('lib/planner/engine.ts', 'utf8');
    expect(src).not.toMatch(/fetchCrowdLoad|crowdLoad/);
  });
});

describe('код больше не читает tour_departures', () => {
  it('в живых файлах нет FROM/JOIN tour_departures', async () => {
    const fs = await import('node:fs');
    for (const f of [
      'app/api/public/now/route.ts',
      'app/api/mcp/route.ts',
      'app/api/cron/digest/route.ts',
      'lib/planner/engine.ts',
      'lib/planner/data.ts',
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
