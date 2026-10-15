/**
 * Двери брони мимо reserveBooking пишут строку ОБЩЕЙ вставкой — проверка
 * вызовом (аудит 15.10, находка P2-01).
 *
 * Правило многодневности 14.09 легло только в reserveBooking. Ручная бронь
 * оператора и OCTO-холд реселлера писали `operator_bookings` своими
 * вставками без `end_date` и `duration_days`, а OCTO вдобавок считал места
 * равенством `booking_date = $2` по одному дню. Пятидневная группа занимала
 * для всех поверхностей занятости только день выезда, и дни 2..N уходили в
 * продажу второй раз.
 *
 * Здесь двери вызываются целиком — роут кабинета и сервис OCTO, — с базой на
 * моке. Общая вставка и гейт обёрнуты шпионами поверх НАСТОЯЩИХ функций:
 * проверяется и то, что дверь их позвала, и то, что ушло в базу.
 *
 * Перепись писателей по коду — tests/unit/booking-single-writer.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const clientQueryMock = vi.fn();
const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (...a: unknown[]) => poolQueryMock(...a),
    connect: () => Promise.resolve({
      query: (...a: unknown[]) => clientQueryMock(...a),
      release: () => {},
    }),
  },
}));

const dbQueryMock = vi.fn();
const txQueryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...a: unknown[]) => dbQueryMock(...a),
  transaction: (cb: (c: { query: (...a: unknown[]) => unknown }) => unknown) =>
    cb({ query: (...a: unknown[]) => txQueryMock(...a) }),
}));

vi.mock('@/lib/bookings/reserve', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/bookings/reserve')>();
  return {
    ...real,
    insertBookingRow: vi.fn(real.insertBookingRow),
    readTourDays: vi.fn(real.readTourDays),
  };
});

const OPERATOR = '22222222-2222-4222-8222-222222222222';
vi.mock('@/lib/auth/middleware', () => ({
  requireOperator: vi.fn(async () => ({ userId: '00000000-0000-4000-8000-0000000000a1', role: 'operator' })),
  requireAdmin: vi.fn(),
  requireRole: vi.fn(),
}));
vi.mock('@/lib/operators/team-access', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/operators/team-access')>();
  return { ...real, operatorAccess: vi.fn(async () => ({ kind: 'owner', partnerId: OPERATOR })) };
});
vi.mock('@/lib/notifications/operator-booking', () => ({ notifyNewBooking: vi.fn(async () => undefined) }));
vi.mock('@/lib/crm/contacts', () => ({ linkContactQuietly: vi.fn(async () => undefined) }));
vi.mock('@/lib/crm/events', () => ({
  recordSourceEventQuietly: vi.fn(async () => undefined),
  statusChangeTitle: () => 'смена',
}));
vi.mock('@/lib/octo/webhooks', () => ({ notifyOctoWebhooks: vi.fn(async () => undefined) }));

import { insertBookingRow, readTourDays } from '@/lib/bookings/reserve';
import { createBooking } from '@/lib/octo/service';
import { POST as manualBooking } from '@/app/api/hub/operator/bookings/route';

/** Значение колонки по ИМЕНИ во вставке в operator_bookings. */
function insertedColumn(calls: unknown[][], column: string): unknown {
  const call = calls.find(([sql]) => /INSERT INTO operator_bookings/.test(String(sql)));
  expect(call, 'вставка в operator_bookings не выполнена').toBeTruthy();
  const [sql, params] = call as [string, unknown[]];
  const names = /INSERT INTO operator_bookings\s*\(([^)]*)\)/.exec(sql)![1].split(',').map((x) => x.trim());
  const slots = /VALUES\s*\(([^)]*)\)/.exec(sql)![1].split(',').map((x) => x.trim());
  const i = names.indexOf(column);
  expect(i, `колонки ${column} нет во вставке`).toBeGreaterThanOrEqual(0);
  return params[Number(/^\$(\d+)/.exec(slots[i]!)![1]) - 1];
}

type Day = { date: string; occupied: string; available_slots: number | null; is_cancelled: boolean | null };
const free = (date: string): Day => ({ date, occupied: '0', available_slots: null, is_cancelled: null });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/* ─── OCTO: холд реселлера ─────────────────────────────────────────────────── */

const OCTO_BOOKING = {
  tourId: '7',
  optionId: 'opt-1',
  availabilityId: 'avail-2026-08-01',
  bookingDate: '2026-08-01',
  adultCount: 2,
  childCount: 0,
  apiKeyId: 'key-1',
};

/** Ответы транзакции OCTO: тур на `days` дней и календарь/занятость по дням. */
function octoDb(tour: { multi_day_count: number | null; max_participants: number | null }, days: Day[]) {
  clientQueryMock.mockImplementation((sql: string) => {
    const s = String(sql);
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(s)) return Promise.resolve({ rows: [] });
    if (s.includes('octo_uuid FROM operator_bookings')) return Promise.resolve({ rows: [] });
    if (s.includes('FROM operator_tours')) {
      return Promise.resolve({ rows: [{ id: '7', base_price: 5000, title: 'Тур', duration_hours: null, ...tour }] });
    }
    if (s.includes('FROM tour_options')) return Promise.resolve({ rows: [{ id: 'opt-1', price_adult: 5000, price_child: 3500 }] });
    if (s.includes('generate_series')) return Promise.resolve({ rows: days });
    if (s.includes('INSERT INTO operator_bookings')) {
      return Promise.resolve({ rows: [{ id: 501, octo_uuid: 'uuid-1', booking_status: 'new', created_at: '2026-07-07' }] });
    }
    return Promise.resolve({ rows: [] });
  });
  poolQueryMock.mockResolvedValue({ rows: [] });
}

describe('OCTO: холд реселлера пишет общей вставкой и проверяется общим гейтом', () => {
  it('трёхдневный тур: гейт спрошен про три дня, во вставке end_date и duration_days', async () => {
    octoDb({ multi_day_count: 3, max_participants: 10 }, ['2026-08-01', '2026-08-02', '2026-08-03'].map(free));

    const result = await createBooking(OCTO_BOOKING);
    expect(result).toEqual({
      booking: { id: 501, octo_uuid: 'uuid-1', booking_status: 'new', created_at: '2026-07-07' },
    });

    expect(vi.mocked(readTourDays)).toHaveBeenCalledWith(expect.anything(), '7', '2026-08-01', '2026-08-03');
    expect(vi.mocked(insertBookingRow)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(insertBookingRow).mock.calls[0]![1]).toMatchObject({
      booking_status: 'new', created_via: 'api', octo_api_key_id: 'key-1', option_id: 'opt-1',
    });

    const calls = clientQueryMock.mock.calls;
    expect(insertedColumn(calls, 'end_date')).toBe('2026-08-03');
    expect(insertedColumn(calls, 'duration_days')).toBe(3);
  });

  it('чужая группа на ВТОРОМ дне диапазона — отказ, вставки нет', async () => {
    // Своим счётом (`booking_date = $2`) OCTO видел только день выезда.
    octoDb({ multi_day_count: 3, max_participants: 10 }, [
      free('2026-08-01'),
      { date: '2026-08-02', occupied: '9', available_slots: 10, is_cancelled: false },
      free('2026-08-03'),
    ]);

    const result = await createBooking(OCTO_BOOKING);
    expect(result).toEqual({ error: 'AVAILABILITY_SOLD_OUT' });
    expect(vi.mocked(insertBookingRow)).not.toHaveBeenCalled();
    expect(clientQueryMock.mock.calls.some(([sql]) => /INSERT INTO operator_bookings/.test(String(sql)))).toBe(false);
    expect(clientQueryMock.mock.calls.some(([sql]) => String(sql) === 'ROLLBACK')).toBe(true);
  });

  it('без строки календаря места меряются вместимостью тура', async () => {
    // Своим счётом OCTO без строки календаря не проверял ничего.
    octoDb({ multi_day_count: null, max_participants: 3 }, [
      { date: '2026-08-01', occupied: '2', available_slots: null, is_cancelled: null },
    ]);

    expect(await createBooking(OCTO_BOOKING)).toEqual({ error: 'AVAILABILITY_SOLD_OUT' });
    expect(vi.mocked(insertBookingRow)).not.toHaveBeenCalled();
  });

  it('день, закрытый оператором, реселлеру не продаётся', async () => {
    octoDb({ multi_day_count: null, max_participants: 10 }, [
      { date: '2026-08-01', occupied: '0', available_slots: 10, is_cancelled: true },
    ]);

    expect(await createBooking(OCTO_BOOKING)).toEqual({ error: 'AVAILABILITY_SOLD_OUT' });
  });

  it('строка тура берётся под замок — тот же, что у брони с сайта', async () => {
    octoDb({ multi_day_count: null, max_participants: 10 }, [free('2026-08-01')]);
    await createBooking(OCTO_BOOKING);
    const tourSql = clientQueryMock.mock.calls.map(([sql]) => String(sql)).find((s) => s.includes('FROM operator_tours'));
    expect(tourSql).toMatch(/FOR UPDATE/);
    expect(tourSql).not.toMatch(/SKIP LOCKED/);
  });
});

/* ─── Ручная бронь оператора ───────────────────────────────────────────────── */

function manualReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://x/api/hub/operator/bookings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function manualDb(tour: { multi_day_count: number | null; duration_hours: number | null }) {
  dbQueryMock.mockImplementation(async (sql: string) => {
    if (/FROM partners p/.test(sql)) return { rows: [{ id: OPERATOR, name: 'Оп', max_chat_id: null, telegram_chat_id: null }] };
    if (/FROM operator_tours/.test(sql)) {
      return { rows: [{ id: '7', title: 'Тур', base_price: 10000, price_unit: null, ...tour }] };
    }
    return { rows: [] };
  });
  txQueryMock.mockImplementation(async (sql: string) => {
    if (/INSERT INTO operator_bookings/.test(sql)) {
      return { rows: [{ id: 601, booking_date: '2026-11-20', participants: 4, final_price: '40000', booking_status: 'confirmed' }] };
    }
    return { rows: [] };
  });
}

describe('ручная бронь оператора пишет общей вставкой', () => {
  it('пятидневный тур по звонку занимает все пять дней', async () => {
    manualDb({ multi_day_count: 5, duration_hours: null });

    const res = await manualBooking(manualReq({
      operator_tour_id: 7, booking_date: '2026-11-20', participants: 4, booking_status: 'confirmed',
    }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      success: true,
      data: { id: 601, booking_date: '2026-11-20', participants: 4, final_price: '40000', booking_status: 'confirmed' },
    });

    expect(vi.mocked(insertBookingRow)).toHaveBeenCalledTimes(1);
    expect(insertedColumn(txQueryMock.mock.calls, 'end_date')).toBe('2026-11-24');
    expect(insertedColumn(txQueryMock.mock.calls, 'duration_days')).toBe(5);
    expect(insertedColumn(txQueryMock.mock.calls, 'booking_status')).toBe('confirmed');
    expect(insertedColumn(txQueryMock.mock.calls, 'created_via')).toBe('direct_contact');
  });

  it('вставка идёт клиентом транзакции, а не мимо неё', async () => {
    manualDb({ multi_day_count: null, duration_hours: 8 });
    await manualBooking(manualReq({ operator_tour_id: 7, booking_date: '2026-11-20', participants: 2 }));
    expect(dbQueryMock.mock.calls.some(([sql]) => /INSERT INTO operator_bookings/.test(String(sql)))).toBe(false);
    expect(insertedColumn(txQueryMock.mock.calls, 'end_date')).toBe('2026-11-20');
  });

  it('гейта нет намеренно: календарь и занятость не спрашиваются', async () => {
    // Оператор записывает договорённость, которая уже состоялась; отказ в
    // записи потерял бы бронь, а не отменил бы поездку.
    manualDb({ multi_day_count: 5, duration_hours: null });
    await manualBooking(manualReq({ operator_tour_id: 7, booking_date: '2026-11-20', participants: 2 }));
    expect(vi.mocked(readTourDays)).not.toHaveBeenCalled();
  });
});
