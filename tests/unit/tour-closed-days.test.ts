/**
 * Закрытые оператором дни у тура без календаря (#3476 шаг 3): «в любой день
 * сезона» и «по заявке». Запрос мест на закрытый день до оператора не
 * доходит, а ответ о датах не называет его «свободно для заявки». Вызовом на
 * подменённой базе; SQL — на PostgreSQL в public-tour-gate.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const q = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...a: unknown[]) => q.query(...a), connect: vi.fn(async () => ({ query: (...a: unknown[]) => q.query(...a), release: vi.fn() })) },
}));

import { tripEnd, tripHitsClosed, CLOSED_DAYS_SQL } from '@/lib/tours/closed-days';
import { createSeatRequest } from '@/lib/seat-requests/service';
import { SEAT_REQUEST_FAILURE } from '@/lib/seat-requests/core';
import { getTourAvailabilityForKuzmich } from '@/lib/kuzmich/tour-availability-tool';

let spy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { spy = vi.spyOn(console, 'error').mockImplementation(() => {}); q.query.mockReset(); });
afterEach(() => { spy.mockRestore(); });

describe('правило: поездка задевает закрытый день', () => {
  const closed = new Set(['2099-08-05']);
  it('однодневная — только в сам день; многодневная — если день внутри поездки', () => {
    expect(tripHitsClosed('2099-08-05', 1, closed)).toBe(true);
    expect(tripHitsClosed('2099-08-04', 1, closed)).toBe(false);
    expect(tripHitsClosed('2099-08-03', 3, closed)).toBe(true);
    expect(tripHitsClosed('2099-08-02', 3, closed)).toBe(false);
    expect(tripHitsClosed('2099-08-06', 4, closed)).toBe(false);
    expect(tripEnd('2099-08-30', 4)).toBe('2099-09-02');
    expect(tripEnd('2099-08-30', 0)).toBe('2099-08-30');
  });
});

describe('запрос мест на закрытый день', () => {
  const TOUR = {
    operator_id: 'op', title: 'Горелый', price_unit: 'per_person', max_participants: 4,
    season_start: '2099-07-15', season_end: '2099-10-15', duration_type: null, multi_day_count: null, duration_hours: 12,
  };
  const input = {
    tourId: 60, date: '2099-08-05', participants: 2, touristName: 'Тест', touristPhone: '+70000000000',
    replyChannel: { kind: 'none' }, pdConsent: { consented: true, version: 't', at: '2099-01-01T00:00:00Z' },
  } as unknown as Parameters<typeof createSeatRequest>[0];

  it('день закрыт — «day_closed» до оператора, со словами для человека', async () => {
    q.query.mockImplementation(async (sql: string) => {
      if (/FROM operator_tours/.test(sql)) return { rows: [TOUR] };
      if (sql === CLOSED_DAYS_SQL) return { rows: [{ d: '2099-08-05' }] };
      throw new Error(`неожиданный запрос: ${sql.slice(0, 60)}`);
    });
    expect(await createSeatRequest(input)).toEqual({ ok: false, reason: 'day_closed' });
    expect(SEAT_REQUEST_FAILURE.day_closed.error).toMatch(/закрыл эту дату/);
  });

  it('закрытые дни не прочитались — «не смог», а не «закрытых нет»', async () => {
    q.query.mockImplementation(async (sql: string) => {
      if (/FROM operator_tours/.test(sql)) return { rows: [TOUR] };
      if (sql === CLOSED_DAYS_SQL) throw Object.assign(new Error('down'), { code: '57P01' });
      throw new Error('дальше идти не должен');
    });
    expect(await createSeatRequest(input)).toEqual({ ok: false, reason: 'check_failed' });
  });
});

describe('get_tour_availability у тура без календаря', () => {
  const TOUR = {
    id: 61, title: 'Горелый', operator_id: 'op', slug: null, base_price: 15000, price_unit: 'per_person',
    multi_day_count: null, duration_hours: 12, duration_type: null,
    season_start: '2099-07-15', season_end: '2099-10-15', schedule_kind: 'any_day',
  };
  it('закрытый день не «свободно для заявки» и назван', async () => {
    q.query.mockImplementation(async (sql: string) => {
      if (sql === CLOSED_DAYS_SQL) return { rows: [{ d: '2099-08-02' }] };
      if (/FROM operator_tours/.test(sql) && /(WHERE|AND) (ot\.)?id = \$1/.test(sql)) return { rows: [TOUR] };
      if (/SELECT \(?EXISTS/.test(sql)) return { rows: [{ has: false }] };
      return { rows: [] };
    });
    const text = await getTourAvailabilityForKuzmich({ tour: '61', date_from: '2099-08-01', days: '3' });
    expect(text).toContain('Оператор закрыл в календаре: 02.08');
    expect(text).toMatch(/- 01\.08(\.2099)?: свободно для заявки/);
    expect(text).toMatch(/- 03\.08(\.2099)?: свободно для заявки/);
    expect(text).not.toMatch(/02\.08[^\n]*свободно для заявки/);
    expect(text).not.toMatch(/01\.08–03\.08/);
  });
});
