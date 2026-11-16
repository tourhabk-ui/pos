/**
 * Перепись целостности броней и заявок (#3388 п.3, шаг 1) — роут вызовом с
 * подменённой базой. Сами запросы судит настоящий PostgreSQL
 * (tests/integration/booking-integrity-census.pg.test.ts); здесь — доступ,
 * три исхода (§4.0) и что ответ называет: отказ одного замера не гасит
 * остальные и не выдаётся за «нарушений нет».
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));

import { GET as census } from '@/app/api/cron/booking-integrity-census/route';
import { MANUAL_ENDPOINTS } from '@/lib/agents/cron-schedulers';
import { CRON_CAPABILITIES } from '@/lib/agents/cron-capability-registry';

const req = (secret: string) => new NextRequest('https://vedarai.ru/api/cron/booking-integrity-census', {
  headers: { authorization: `Bearer ${secret}` },
});

const RULES = {
  total: 3, live: 3, active: 0, participants_not_positive: 0, parts_mismatch: 0, parts_negative: 0,
  date_before_creation: 0, date_beyond_two_years: 0, end_before_start: 0, cancelled_then_active: 0,
  cancelled_without_time: 1, without_consent: 3, active_without_consent: 0,
};

function db(opts: { failRepeats?: boolean } = {}) {
  queryMock.mockImplementation(async (sql: string) => {
    if (/FROM pg_constraint/.test(sql)) {
      return { rows: [{ table_name: 'operator_bookings', kind: 'constraint', name: 'participants_valid', type: 'c', validated: true }] };
    }
    if (/HAVING COUNT\(\*\) > 1/.test(sql)) {
      if (opts.failRepeats) throw Object.assign(new Error('boom'), { code: '42P01' });
      return { rows: [{ groups: 0, rows: 0 }] };
    }
    if (/COUNT\(DISTINCT/.test(sql)) return { rows: [{ dates: 0, max_people_on_date: 0 }] };
    if (/JOIN operator_tours t/.test(sql)) return { rows: [{ on_deleted_tour: 0, active_on_deleted_tour: 0 }] };
    if (/FROM leads/.test(sql)) return { rows: [{ total: 0, cancelled_by_client: 0, without_consent: 0, without_consent_not_self: 0, group_size_not_positive: 0 }] };
    if (/FROM operator_bookings/.test(sql)) return { rows: [RULES] };
    throw new Error(`неожиданный запрос: ${sql}`);
  });
}

beforeEach(() => {
  queryMock.mockReset();
  process.env.CRON_SECRET = 'test-secret';
});

describe('перепись целостности броней', () => {
  it('без секрета — 401, в базу не ходит', async () => {
    const res = await census(req('wrong'));
    expect(res.status).toBe(401);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('все замеры ответили — 200, числа и готовность правил', async () => {
    db();
    const res = await census(req('test-secret'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.bookings).toMatchObject({ total: 3, cancelled_without_time: 1, without_consent: 3 });
    expect(body.constraint_ready).toMatchObject({ participants_positive: true, no_repeat_same_person: true });
    expect(body.existing_guards.operator_bookings).toEqual([
      { kind: 'constraint', name: 'participants_valid', type: 'c', validated: true },
    ]);
    expect(body.failed).toEqual([]);
  });

  it('замер повторов упал — 500 с именем и SQLSTATE; остальные замеры на месте, готовность повтора — null, а не «можно»', async () => {
    db({ failRepeats: true });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await census(req('test-secret'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.failed).toEqual([{ measure: 'booking_repeats', sqlstate: '42P01' }]);
    expect(body.booking_repeats).toBeNull();
    expect(body.constraint_ready.no_repeat_same_person).toBeNull();
    expect(body.bookings).toMatchObject({ total: 3 });
  });

  it('объявлена ручной переписью только на чтение', () => {
    expect(MANUAL_ENDPOINTS['booking-integrity-census']).toMatchObject({ kind: 'manual', writes: false });
    expect(CRON_CAPABILITIES['booking-integrity-census']).toEqual(['db_read']);
  });
});
