/**
 * tests/unit/booking-single-writer.test.ts
 *
 * Бронь заводится ОДНИМ кодом — `lib/bookings/reserve.ts`.
 *
 * Копий было две, и они разошлись по трём признакам: Кузьмич не читал
 * календарь оператора (бронь принималась на закрытую им дату), ставил статус
 * `pending_payment` и не писал `user_id`. Последнее и есть потерянная бронь:
 * `loadUserSituation` ищет по `user_id` и по статусам `('new','confirmed')` —
 * бронь из чата не проходила ни по одному условию, и тот же Кузьмич через
 * минуту отвечал туристу, что броней у него нет. Кабинет оператора считает
 * новые заявки по `booking_status = 'new'` — там она тоже не показывалась.
 *
 * Сторож держит закрытие: один писатель, один статус, и этот статус знают оба
 * читателя — «ситуация туриста» и календарь оператора.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const RESERVE  = read('lib/bookings/reserve.ts');
const CORE     = read('lib/kuzmich/core.ts');
const CREATE   = read('app/api/hub/bookings/create/route.ts');
const CALENDAR = read('app/api/hub/operator/bookings-calendar/route.ts');

const clientQueryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  transaction: (cb: (client: { query: (...args: unknown[]) => unknown }) => unknown) =>
    cb({ query: (...args: unknown[]) => clientQueryMock(...args) }),
}));

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

import { createBooking } from '@/lib/kuzmich/core';
import { NEW_BOOKING_STATUS } from '@/lib/bookings/reserve';

const TOUR = { id: 7, title: 'Вулкан Горелый', base_price: 9000, multi_day_count: null };

const PENDING = {
  tour: TOUR,
  name: 'Иван Иванов',
  phone: '+79991234567',
  participants: 2,
  date: '2099-07-01',
};

/** Вызов INSERT в operator_bookings: сам SQL и его параметры. */
function insertCall(): [string, unknown[]] {
  const call = clientQueryMock.mock.calls.find(([sql]) =>
    String(sql).includes('INSERT INTO operator_bookings'));
  expect(call, 'INSERT в operator_bookings не вызван').toBeTruthy();
  return call as [string, unknown[]];
}

/** Значение колонки по ИМЕНИ, а не по месту в массиве параметров. */
function inserted(column: string): unknown {
  const [sql, params] = insertCall();
  const columns = /INSERT INTO operator_bookings\s*\(([^)]*)\)/i.exec(sql)?.[1];
  const values  = /VALUES\s*\(([^)]*)\)/i.exec(sql)?.[1];
  expect(columns, 'не разобран список колонок INSERT').toBeTruthy();
  expect(values, 'не разобран список значений INSERT').toBeTruthy();

  const names = columns!.split(',').map(s => s.trim());
  const slots = values!.split(',').map(s => s.trim());
  expect(names.length, 'колонок и значений разное число').toBe(slots.length);

  const at = names.indexOf(column);
  expect(at, `колонки ${column} нет в INSERT`).toBeGreaterThanOrEqual(0);
  const n = Number(/^\$(\d+)/.exec(slots[at]!)?.[1]);
  expect(Number.isFinite(n), `значение ${column} — не параметр: ${slots[at]}`).toBe(true);
  return params[n - 1];
}

function mockDb(opts: { calendar?: unknown[]; user?: unknown[] } = {}) {
  clientQueryMock.mockImplementation((sql: string) => {
    const s = String(sql);
    if (s.includes('FROM operator_tours'))    return Promise.resolve({ rows: [{ operator_id: 'op-1', title: TOUR.title, base_price: '9000', max_participants: 10 }] });
    if (s.includes('FROM tour_availability')) return Promise.resolve({ rows: opts.calendar ?? [] });
    if (s.includes('already_booked'))         return Promise.resolve({ rows: [{ already_booked: '0' }] });
    if (s.includes('INSERT INTO operator_bookings'))
      return Promise.resolve({ rows: [{ id: 101, access_token: '11111111-2222-3333-4444-555555555555' }] });
    throw new Error('unexpected SQL: ' + s);
  });
  poolQueryMock.mockImplementation((sql: string) => {
    if (String(sql).includes('FROM users WHERE telegram_id')) {
      return Promise.resolve({ rows: opts.user ?? [] });
    }
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb();
});

describe('писатель брони один на обе поверхности', () => {
  it('свою вставку в operator_bookings не делает ни веб-роут, ни Кузьмич', () => {
    for (const [name, src] of [['веб-роут', CREATE], ['Кузьмич', CORE]] as const) {
      expect(src, `${name}: своя копия вставки неизбежно разойдётся с общей`)
        .not.toMatch(/INSERT\s+INTO\s+operator_bookings/i);
      expect(src, `${name}: бронь заводится через общий модуль`).toMatch(/reserveBooking\(/);
    }
  });

  it('лок и счёт занятости стоят в общем модуле, а не в одной из копий', () => {
    expect(RESERVE).toMatch(/FOR UPDATE/);
    expect(RESERVE).toMatch(/already_booked/);
    expect(RESERVE).toMatch(/FROM tour_availability/);
  });
});

describe('бронь из чата видна там, где её ищут', () => {
  it('статус — тот же, что у веб-брони, и это не pending_payment', async () => {
    await createBooking(PENDING as never, 'kuzmich_tg', 555, 'tg');
    expect(NEW_BOOKING_STATUS).toBe('new');
    expect(inserted('booking_status')).toBe(NEW_BOOKING_STATUS);
  });

  it('«ситуация туриста» принимает этот статус — иначе бронь снова невидима', () => {
    const situation = /booking_status IN \(([^)]*)\)/.exec(CORE)?.[1] ?? '';
    expect(situation, 'не найден список статусов в loadUserSituation').not.toBe('');
    expect(situation).toContain(`'${NEW_BOOKING_STATUS}'`);
  });

  it('календарь оператора считает этот статус новой заявкой', () => {
    expect(CALENDAR).toContain(`booking_status === '${NEW_BOOKING_STATUS}'`);
  });

  it('аккаунт по чату Telegram проставляется в user_id', async () => {
    mockDb({ user: [{ id: 'user-42' }] });
    await createBooking(PENDING as never, 'kuzmich_tg', 555, 'tg');
    expect(inserted('user_id')).toBe('user-42');
  });

  it('аккаунта нет — null, а не выдуманная связь; метка канала остаётся', async () => {
    await createBooking(PENDING as never, 'kuzmich_tg', 555, 'tg');
    expect(inserted('user_id')).toBeNull();
    expect(JSON.parse(String(inserted('metadata')))).toMatchObject({ tg_chat_id: 555, platform: 'tg' });
  });

  it('у MAX сопоставления по chat_id нет — аккаунт не угадывается', async () => {
    mockDb({ user: [{ id: 'user-42' }] });
    await createBooking(PENDING as never, 'kuzmich_max', 555, 'max');
    expect(inserted('user_id')).toBeNull();
    expect(poolQueryMock.mock.calls.some(([sql]) => String(sql).includes('FROM users WHERE telegram_id')))
      .toBe(false);
  });

  it('бронь из чата находится и по метке канала — у старых записей user_id пуст', () => {
    expect(CORE).toMatch(/metadata->>'tg_chat_id'/);
  });
});

describe('календарь оператора уважается обоими путями', () => {
  it('дата закрыта оператором → бронь из чата не заводится', async () => {
    mockDb({ calendar: [{ available_slots: 10, is_cancelled: true }] });
    await expect(createBooking(PENDING as never, 'kuzmich_tg', 555, 'tg')).rejects.toThrow(/закрыл бронирование/);
    expect(clientQueryMock.mock.calls.some(([sql]) =>
      String(sql).includes('INSERT INTO operator_bookings'))).toBe(false);
  });
});
