/**
 * tests/unit/stay-owner-decision.test.ts
 *
 * Решение владельца по брони жилья доходит до базы и до гостя (26.09).
 *
 * 1. 42P08. `SET status = $1` (varchar) и `CASE WHEN $1 = 'cancelled'`
 *    (text) — один параметр, два вывода типа. node-pg шлёт параметры без
 *    типа, и запрос не готовился НИ РАЗУ: владелец не мог ни подтвердить,
 *    ни отменить, ни отметить заезд. Юниты с моком были зелёными — мок
 *    отвечает на любой SQL. Приговор выносит PREPARE (локально проверено,
 *    на проде — /api/cron/sql-shape-check, куда запрос внесён); здесь
 *    держится, что каждое употребление $1 приведено и что роут шлёт именно
 *    этот запрос.
 * 2. Гость не узнавал о решении: PATCH уведомлял только владельца и админа.
 *    Теперь подтверждение и отмена уходят гостю (письмо, push, Telegram),
 *    причина отмены — экранированной.
 * 3. «Заезд состоялся» и «не заехал» на будущей брони — ложь в данных:
 *    неявкой можно было освободить номер, пока гость ещё едет. Только с дня
 *    заезда по Камчатке, иначе 409.
 * 4. Подтверждение перепроверяет занятость под блокировкой объекта: заявка
 *    старше срока удержания номер не держит, и его могли продать.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const clientQueryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  transaction: (cb: (c: { query: (...a: unknown[]) => unknown }) => unknown) =>
    cb({ query: (...a: unknown[]) => clientQueryMock(...a) }),
  query: vi.fn(),
}));

const requireAuthMock = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}));

vi.mock('@/lib/auth/stay-helpers', () => ({
  getStayPartnerId: vi.fn().mockResolvedValue('partner-1'),
}));

const notifyCancelMock = vi.fn();
const notifyGuestMock = vi.fn();
const logMock = vi.fn();
vi.mock('@/lib/notifications/stay-booking', () => ({
  notifyStayBookingCancelled: (...args: unknown[]) => notifyCancelMock(...args),
  notifyStayGuestStatus: (...args: unknown[]) => notifyGuestMock(...args),
  logStayFailure: (...args: unknown[]) => logMock(...args),
}));

import { PATCH } from '@/app/api/stay/bookings/[id]/route';
import { UPDATE_STAY_BOOKING_STATUS_SQL } from '@/lib/stay/booking-status-sql';
import { SHAPES } from '@/app/api/cron/sql-shape-check/route';

const BOOKING_ID = '77777777-7777-4777-8777-777777777777';
const ROUTE_SRC = readFileSync(join(process.cwd(), 'app/api/stay/bookings/[id]/route.ts'), 'utf-8');

function patch(body: unknown) {
  return PATCH(
    new Request(`http://localhost/api/stay/bookings/${BOOKING_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as NextRequest,
    { params: Promise.resolve({ id: BOOKING_ID }) },
  );
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID, status: 'pending', payment_status: 'pending', total_price: '12000',
    user_id: 'guest-1', accommodation_id: 'acc-1', room_id: 'room-1',
    check_in_date: '2099-08-01', check_out_date: '2099-08-03', checkin_reached: false,
    accommodation_name: 'Дом у вулкана', room_name: 'Люкс', owner_chat: null,
    ...over,
  };
}

function db(bookingRow: Record<string, unknown>, nights: { night: string; free_units: number; blocked?: boolean }[] = [
  { night: '2099-08-01', free_units: 1 }, { night: '2099-08-02', free_units: 1 },
]) {
  clientQueryMock.mockImplementation((sql: string) => {
    if (sql.includes('FOR UPDATE OF b')) return Promise.resolve({ rows: [bookingRow] });
    if (sql.includes('pg_advisory_xact_lock')) return Promise.resolve({ rows: [] });
    if (sql.includes('CROSS JOIN generate_series')) return Promise.resolve({ rows: nights });
    if (sql.includes('UPDATE accommodation_bookings')) return Promise.resolve({ rows: [{ id: BOOKING_ID }] });
    throw new Error('unexpected SQL: ' + sql);
  });
}

const updates = () => clientQueryMock.mock.calls.filter(([sql]) => String(sql).includes('UPDATE accommodation_bookings'));

beforeEach(() => {
  clientQueryMock.mockReset();
  requireAuthMock.mockReset();
  notifyCancelMock.mockReset();
  notifyGuestMock.mockReset();
  logMock.mockReset();
  requireAuthMock.mockResolvedValue({ userId: 'owner-1', role: 'stay' });
});

describe('42P08: параметр статуса приведён у каждого употребления', () => {
  it('в запросе нет ни одного $1 без ::varchar', () => {
    const uses = UPDATE_STAY_BOOKING_STATUS_SQL.match(/\$1\b(::\w+)?/g) ?? [];
    expect(uses.length, 'запрос должен употреблять $1').toBeGreaterThanOrEqual(2);
    expect(uses.every(u => u === '$1::varchar'), `употребления: ${uses.join(', ')}`).toBe(true);
  });

  it('запрос внесён в реестр PREPARE-проверки прода дословно', () => {
    const skeleton = (s: string) => s.replace(/\s+/g, ' ').trim();
    const entry = SHAPES.find(s => s.source === 'lib/stay/booking-status-sql.ts');
    expect(entry, 'нет записи в SHAPES').toBeDefined();
    expect(skeleton(entry!.sql)).toBe(skeleton(UPDATE_STAY_BOOKING_STATUS_SQL));
  });

  it('роут шлёт в базу ИМЕННО этот запрос, а не свою копию', async () => {
    db(row());
    const res = await patch({ status: 'confirmed' });
    expect(res.status).toBe(200);
    expect(updates()).toHaveLength(1);
    expect(updates()[0][0]).toBe(UPDATE_STAY_BOOKING_STATUS_SQL);
    expect(updates()[0][1][0]).toBe('confirmed');
  });
});

describe('гость узнаёт о решении владельца', () => {
  it('подтверждение → уведомление гостю со статусом confirmed', async () => {
    db(row());
    const res = await patch({ status: 'confirmed' });
    expect(res.status).toBe(200);
    expect(notifyGuestMock).toHaveBeenCalledTimes(1);
    expect(notifyGuestMock.mock.calls[0][0]).toMatchObject({
      guestUserId: 'guest-1', status: 'confirmed', bookingId: BOOKING_ID, accommodationName: 'Дом у вулкана',
    });
  });

  it('отмена с причиной → гостю уходит причина, в базу — шестым параметром', async () => {
    db(row());
    const res = await patch({ status: 'cancelled', reason: 'Ремонт <b>крыши</b>' });
    expect(res.status).toBe(200);
    expect(notifyGuestMock.mock.calls[0][0]).toMatchObject({
      status: 'cancelled', cancellationReason: 'Ремонт <b>крыши</b>', wasPaid: false,
    });
    expect(updates()[0][1][5]).toBe('Ремонт <b>крыши</b>');
    expect(notifyCancelMock).toHaveBeenCalledTimes(1);
  });

  it('сбой уведомления не отменяет решение, но пишется в лог', async () => {
    db(row());
    notifyGuestMock.mockRejectedValue(new Error('smtp down'));
    const res = await patch({ status: 'confirmed' });
    expect(res.status).toBe(200);
    expect(logMock).toHaveBeenCalledWith('PATCH: уведомление гостю', expect.any(Error));
  });

  it('заезд состоялся — гостю не пишем (это не решение по брони)', async () => {
    db(row({ status: 'confirmed', checkin_reached: true }));
    const res = await patch({ status: 'completed' });
    expect(res.status).toBe(200);
    expect(notifyGuestMock).not.toHaveBeenCalled();
  });
});

describe('заезд и неявка — только с дня заезда (Камчатка)', () => {
  for (const next of ['no_show', 'completed'] as const) {
    it(`${next} на будущей брони → 409, в базу ничего`, async () => {
      db(row({ status: 'confirmed', checkin_reached: false }));
      const res = await patch({ status: next });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/в день заезда или позже/);
      expect(updates()).toHaveLength(0);
    });

    it(`${next} в день заезда и позже → 200`, async () => {
      db(row({ status: 'confirmed', checkin_reached: true }));
      const res = await patch({ status: next });
      expect(res.status).toBe(200);
      expect(updates()).toHaveLength(1);
    });
  }

  it('день считается по Камчатке, а не по часам сервера', () => {
    expect(ROUTE_SRC).toContain('(b.check_in_date <= ${KAMCHATKA_TODAY_SQL}) AS checkin_reached');
  });
});

describe('подтверждение перепроверяет занятость', () => {
  it('номер за это время заняли → 409, бронь не подтверждена', async () => {
    db(row(), [{ night: '2099-08-01', free_units: 1 }, { night: '2099-08-02', free_units: 0 }]);
    const res = await patch({ status: 'confirmed' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/02\.08\.2099/);
    expect(updates()).toHaveLength(0);
    expect(notifyGuestMock).not.toHaveBeenCalled();
  });

  it('перепроверка — под блокировкой объекта и без самой заявки', async () => {
    db(row());
    await patch({ status: 'confirmed' });
    const lock = clientQueryMock.mock.calls.find(([sql]) => String(sql).includes('pg_advisory_xact_lock'))!;
    expect(lock[1]).toEqual(['acc-1']);
    const nights = clientQueryMock.mock.calls.find(([sql]) => String(sql).includes('CROSS JOIN generate_series'))!;
    expect(String(nights[0])).toContain('b.id <> $5::uuid');
    expect(nights[1]).toEqual(['acc-1', '2099-08-01', '2099-08-03', 'room-1', BOOKING_ID]);
  });
});
