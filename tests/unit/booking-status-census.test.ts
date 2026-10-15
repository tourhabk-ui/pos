/**
 * Сторож переписи статусов броней (аудит 15.10, A11).
 *
 * CHECK на `operator_bookings.booking_status` ставится только после замера:
 * строка вне словаря, которой никто не видел, уронит VALIDATE. Перепись
 * обязана назвать такие строки поимённо и с числами, отличить «CHECK нет» от
 * «не смогли спросить» и не выдать отказ базы за пустую перепись (§4.0).
 *
 * Судим поведение: вызываем роут с подменённой базой и смотрим ответ.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));

import { GET as census } from '@/app/api/cron/booking-status-census/route';
import { BOOKING_STATUSES } from '@/lib/types/statuses';
import { MANUAL_ENDPOINTS } from '@/lib/agents/cron-schedulers';
import { CRON_CAPABILITIES } from '@/lib/agents/cron-capability-registry';

const req = (secret: string) => new NextRequest('https://vedarai.ru/api/cron/booking-status-census', {
  headers: { authorization: `Bearer ${secret}` },
});

type Rows = Record<string, unknown>[];
interface Fixture {
  operator?: Rows | Error;
  accommodation?: Rows | Error;
  gear?: Rows | Error;
  checks?: Rows | Error;
}

/** Подменённая база: отвечает по тому, к какой таблице обращён запрос. */
function db(f: Fixture) {
  queryMock.mockImplementation(async (sql: string) => {
    const pick = /FROM pg_constraint/.test(sql) ? f.checks
      : /FROM operator_bookings/.test(sql) ? f.operator
        : /FROM accommodation_bookings/.test(sql) ? f.accommodation
          : /FROM gear_rentals/.test(sql) ? f.gear
            : new Error(`неожиданный запрос: ${sql}`);
    if (pick instanceof Error) throw pick;
    return { rows: pick ?? [] };
  });
}

const sqlError = (code: string) => Object.assign(new Error('boom'), { code });

const ACCOMMODATION_CHECK = {
  table_name: 'accommodation_bookings', column_name: 'status', name: 'accommodation_bookings_status_check',
  validated: true, def: "CHECK (((status)::text = ANY (ARRAY['pending', 'confirmed'])))",
};

beforeEach(() => {
  queryMock.mockReset();
  process.env.CRON_SECRET = 'test-secret';
});

describe('доступ', () => {
  it('без секрета — 401, в базу не ходит', async () => {
    const res = await census(req('wrong'));
    expect(res.status).toBe(401);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('числа и строки вне словаря', () => {
  it('называет значения вне словаря, rejected и пустые значения словаря; CHECK по словарю сейчас не прошёл бы', async () => {
    db({
      operator: [
        { status: 'new', rows: '3', live: '3', first_at: '2026-08-01', last_at: '2026-10-14' },
        { status: 'pending', rows: '4', live: '2', first_at: '2026-05-01', last_at: '2026-06-01' },
        { status: 'confirmed', rows: '2', live: '2', first_at: '2026-08-02', last_at: '2026-10-10' },
        { status: 'rejected', rows: '1', live: '0', first_at: '2026-07-01', last_at: '2026-07-01' },
      ],
      accommodation: [{ status: 'pending', rows: '5', first_at: '2026-09-01', last_at: '2026-10-01' }],
      gear: [],
      checks: [ACCOMMODATION_CHECK],
    });
    const res = await census(req('test-secret'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.failed).toEqual([]);
    expect(body.dictionary).toEqual([...BOOKING_STATUSES]);

    const ob = body.operator_bookings;
    expect(ob.total_rows).toBe(10);
    expect(ob.by_status.map((r: { status: string; in_dictionary: boolean }) => [r.status, r.in_dictionary])).toEqual([
      ['new', true], ['pending', false], ['confirmed', true], ['rejected', false],
    ]);
    expect(ob.outside_dictionary.map((r: { status: string }) => r.status)).toEqual(['pending', 'rejected']);
    expect(ob.outside_dictionary_rows).toBe(5);
    expect(ob.outside_dictionary[0]).toMatchObject({ status: 'pending', rows: 4, live: 2, last_at: '2026-06-01' });
    expect(ob.rejected_rows).toBe(1);
    expect(ob.dictionary_without_rows).toEqual(['pending_payment', 'completed', 'cancelled', 'no_show']);
    expect(ob.check_by_dictionary_would_validate_now).toBe(false);
    // запрос CHECK прошёл, на этой колонке их нет — это знание, пустой список
    expect(ob.check_constraints).toEqual([]);

    const acc = body.own_status_columns.accommodation_bookings;
    expect(acc).toMatchObject({ column: 'status', total_rows: 5 });
    expect(acc.by_status[0]).toEqual({ status: 'pending', rows: 5, first_at: '2026-09-01', last_at: '2026-10-01' });
    expect(acc.check_constraints).toEqual([
      { name: 'accommodation_bookings_status_check', column: 'status', validated: true, def: ACCOMMODATION_CHECK.def },
    ]);
    expect(body.own_status_columns.gear_rentals).toEqual({ column: 'status', total_rows: 0, by_status: [], check_constraints: [] });
  });

  it('все строки в словаре — CHECK по словарю прошёл бы, rejected нет', async () => {
    db({
      operator: [
        { status: 'confirmed', rows: '7', live: '6', first_at: '2026-08-01', last_at: '2026-10-14' },
        { status: 'no_show', rows: '1', live: '1', first_at: '2026-09-01', last_at: '2026-09-01' },
      ],
      accommodation: [], gear: [], checks: [],
    });
    const body = await (await census(req('test-secret'))).json();
    expect(body.operator_bookings.outside_dictionary).toEqual([]);
    expect(body.operator_bookings.outside_dictionary_rows).toBe(0);
    expect(body.operator_bookings.rejected_rows).toBe(0);
    expect(body.operator_bookings.check_by_dictionary_would_validate_now).toBe(true);
  });

  it('пустой статус — тоже вне словаря, а не «не учтён»', async () => {
    db({
      operator: [{ status: null, rows: '2', live: '2', first_at: null, last_at: null }],
      accommodation: [], gear: [], checks: [],
    });
    const body = await (await census(req('test-secret'))).json();
    expect(body.operator_bookings.outside_dictionary).toEqual([
      { status: null, rows: 2, live: 2, first_at: null, last_at: null, in_dictionary: false },
    ]);
    expect(body.operator_bookings.check_by_dictionary_would_validate_now).toBe(false);
  });

  it('только чтение: ни один запрос ничего не пишет', async () => {
    db({ operator: [], accommodation: [], gear: [], checks: [] });
    await census(req('test-secret'));
    expect(queryMock).toHaveBeenCalledTimes(4);
    for (const [sql] of queryMock.mock.calls) {
      expect(String(sql)).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE)\b/i);
    }
  });
});

describe('отказ базы — не пустая перепись', () => {
  it('упал главный замер — 500, имя замера и SQLSTATE, вместо чисел null', async () => {
    db({ operator: sqlError('42P01'), accommodation: [], gear: [], checks: [] });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await census(req('test-secret'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.failed).toEqual([{ measure: 'operator_bookings', sqlstate: '42P01' }]);
    expect(body.operator_bookings).toBeNull();
    // прочие замеры не теряются из-за одного упавшего
    expect(body.own_status_columns.accommodation_bookings).toMatchObject({ total_rows: 0 });
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0].join(' '))).toMatch(/operator_bookings.*sqlstate=42P01/);
    err.mockRestore();
  });

  it('не спросили про CHECK — «не знаю» (null), а не «CHECK нет» ([])', async () => {
    db({
      operator: [{ status: 'new', rows: '1', live: '1', first_at: null, last_at: null }],
      accommodation: [], gear: [], checks: sqlError('42501'),
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await census(req('test-secret'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.failed).toEqual([{ measure: 'check_constraints', sqlstate: '42501' }]);
    expect(body.operator_bookings.check_constraints).toBeNull();
    expect(body.own_status_columns.gear_rentals.check_constraints).toBeNull();
    // числа при этом есть
    expect(body.operator_bookings.total_rows).toBe(1);
    err.mockRestore();
  });

  it('отказ без кода — sqlstate null, а не выдуманный код', async () => {
    db({ operator: [], accommodation: new Error('сеть'), gear: [], checks: [] });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await census(req('test-secret'));
    expect(res.status).toBe(500);
    expect((await res.json()).failed).toEqual([{ measure: 'accommodation_bookings', sqlstate: null }]);
    err.mockRestore();
  });
});

describe('объявлена там, где положено', () => {
  it('ручная перепись без записи; возможности — только чтение базы', () => {
    const decl = MANUAL_ENDPOINTS['booking-status-census'];
    expect(decl?.kind).toBe('manual');
    expect(decl?.writes).toBe(false);
    expect(CRON_CAPABILITIES['booking-status-census']).toEqual(['db_read']);
  });
});
