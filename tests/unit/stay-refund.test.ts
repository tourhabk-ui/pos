/**
 * tests/unit/stay-refund.test.ts
 *
 * Честный возврат при отмене жилья (24.09, решение владельца «сделай отмену
 * жилья честной»):
 * - возврат всегда 100% (как у туров, 11.09) — лестницы 100/50/0 больше нет;
 * - отмена НЕ ставит payment_status=refunded: денег она не возвращает;
 * - неоплаченной (pending) → без суммы.
 * Физический возврат по CloudPayments — офлайн (в коде не эмулируется).
 *
 * Правка 26.09 (решение владельца: жильё оплачивается владельцу НА МЕСТЕ при
 * заселении, платформа денег за жильё не принимает):
 * - у новых броней предоплаты нет — возвращать нечего; сумма к возврату
 *   бывает только у СТАРОЙ брони, оплаченной через платформу;
 * - «возвращено» (refund_done) ставит ТОЛЬКО администратор: деньги по такой
 *   брони у платформы, у владельца их нет. Владелец получает 403 с
 *   объяснением — прежде он мог отметить «возврат выполнен» за деньги,
 *   которых не держал (§7);
 * - запрос смены статуса несёт шестой параметр — причину отмены словами
 *   владельца (миграция 1028), поэтому длина параметров 6, а не 5.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { calculateStayRefund } from '@/lib/stay/refund-policy';

// ── Политика ────────────────────────────────────────────────────────────────
describe('calculateStayRefund', () => {
  const future = (hours: number) => new Date(Date.now() + hours * 3600 * 1000);

  it('владелец/админ → всегда 100%', () => {
    const r = calculateStayRefund(10000, future(1), true);
    expect(r.percent).toBe(100);
    expect(r.amount).toBe(10000);
  });

  it('гость >48ч до заезда → 100%', () => {
    const r = calculateStayRefund(10000, future(72), false);
    expect(r.percent).toBe(100);
    expect(r.amount).toBe(10000);
  });

  it('гость за 24–48ч и меньше суток — тоже 100% (лестница снята)', () => {
    expect(calculateStayRefund(9999, future(36), false)).toMatchObject({ percent: 100, amount: 9999 });
    expect(calculateStayRefund(10000, future(5), false)).toMatchObject({ percent: 100, amount: 10000 });
  });
});

// ── Роуты ─────────────────────────────────────────────────────────────────
const clientQueryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  transaction: (cb: (c: { query: (...a: unknown[]) => unknown }) => unknown) =>
    cb({ query: (...a: unknown[]) => clientQueryMock(...a) }),
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
vi.mock('@/lib/notifications/stay-booking', () => ({
  notifyStayBookingCancelled: (...args: unknown[]) => notifyCancelMock(...args),
  notifyStayGuestStatus: (...args: unknown[]) => notifyGuestMock(...args),
  logStayFailure: vi.fn(),
}));

import { POST as cancelBooking } from '@/app/api/stay/bookings/[id]/cancel/route';
import { PATCH as ownerPatch } from '@/app/api/stay/bookings/[id]/route';

const BOOKING_ID = '55555555-5555-5555-8555-555555555555';
const farFuture = new Date(Date.now() + 72 * 3600 * 1000).toISOString();

function req(url: string, method: string, body?: unknown): NextRequest {
  return new Request(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }) as unknown as NextRequest;
}
const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  clientQueryMock.mockReset();
  requireAuthMock.mockReset();
  notifyCancelMock.mockReset();
  requireAuthMock.mockResolvedValue({ userId: 'guest-1', role: 'tourist' });
});

describe('POST /cancel — возврат при отмене гостем', () => {
  function selectRow(row: Record<string, unknown>) {
    clientQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('FOR UPDATE OF b')) return Promise.resolve({ rows: [row] });
      if (sql.includes('UPDATE accommodation_bookings')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });
  }

  it('оплаченная → refund_amount=total, payment_status НЕ меняется, notify с суммой', async () => {
    selectRow({
      status: 'confirmed', payment_status: 'paid', total_price: '20000',
      is_future: true, check_in_date: farFuture, check_out_date: farFuture,
      accommodation_name: 'Дом', owner_chat: 'owner-1',
    });
    const res = await cancelBooking(req(`http://localhost/api/stay/bookings/${BOOKING_ID}/cancel`, 'POST'), routeParams(BOOKING_ID));
    expect(res.status).toBe(200);

    const updateCall = clientQueryMock.mock.calls.find(([sql]) => String(sql).includes('UPDATE accommodation_bookings'))!;
    // params: [id, refund_amount, refund_percent, refund_reason]
    expect(updateCall[1][1]).toBe(20000);
    expect(updateCall[1][2]).toBe(100);
    expect(updateCall[1]).toHaveLength(4);
    expect(String(updateCall[0])).not.toMatch(/payment_status/);

    expect(notifyCancelMock).toHaveBeenCalledTimes(1);
    const arg = notifyCancelMock.mock.calls[0][0];
    expect(arg.wasPaid).toBe(true);
    expect(arg.refundAmount).toBe(20000);
    expect(arg.refundPercent).toBe(100);
  });

  it('неоплаченная (pending) → payment_status не меняется, возврата нет', async () => {
    selectRow({
      status: 'pending', payment_status: 'pending', total_price: '20000',
      is_future: true, check_in_date: farFuture, check_out_date: farFuture,
      accommodation_name: 'Дом', owner_chat: null,
    });
    const res = await cancelBooking(req(`http://localhost/api/stay/bookings/${BOOKING_ID}/cancel`, 'POST'), routeParams(BOOKING_ID));
    expect(res.status).toBe(200);

    const updateCall = clientQueryMock.mock.calls.find(([sql]) => String(sql).includes('UPDATE accommodation_bookings'))!;
    expect(updateCall[1][1]).toBeNull();       // refund_amount
    expect(notifyCancelMock.mock.calls[0][0].wasPaid).toBe(false);
  });
});

describe('PATCH /[id] — отмена владельцем оплаченной брони → 100%', () => {
  it('confirmed(paid) → cancelled: 100% к возврату, payment_status не тронут, notify byOwner', async () => {
    requireAuthMock.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
    clientQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('FOR UPDATE OF b')) {
        return Promise.resolve({ rows: [{
          id: BOOKING_ID, status: 'confirmed', payment_status: 'paid', total_price: '15000',
          check_in_date: farFuture, check_out_date: farFuture,
          accommodation_name: 'База', owner_chat: 'owner-9',
        }] });
      }
      if (sql.includes('UPDATE accommodation_bookings')) {
        return Promise.resolve({ rows: [{ id: BOOKING_ID, status: 'cancelled' }] });
      }
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await ownerPatch(
      req(`http://localhost/api/stay/bookings/${BOOKING_ID}`, 'PATCH', { status: 'cancelled' }),
      routeParams(BOOKING_ID)
    );
    expect(res.status).toBe(200);

    const updateCall = clientQueryMock.mock.calls.find(([sql]) => String(sql).includes('UPDATE accommodation_bookings'))!;
    // params: [nextStatus, id, refund_amount, refund_percent, refund_reason, cancellation_reason]
    expect(updateCall[1][2]).toBe(15000);
    expect(updateCall[1][3]).toBe(100);
    expect(updateCall[1]).toHaveLength(6);
    expect(String(updateCall[0])).not.toMatch(/payment_status/);

    expect(notifyCancelMock).toHaveBeenCalledTimes(1);
    expect(notifyCancelMock.mock.calls[0][0].byOwner).toBe(true);
    expect(notifyCancelMock.mock.calls[0][0].refundAmount).toBe(15000);
  });
});

describe('PATCH /[id] refund_done — «деньги переведены» (только администрация)', () => {
  it('владелец объекта — 403: денег по брони у него нет, запрос в базу не уходит', async () => {
    requireAuthMock.mockResolvedValue({ userId: 'owner-1', role: 'stay' });
    clientQueryMock.mockImplementation(() => Promise.resolve({ rowCount: 1, rows: [{ id: BOOKING_ID }] }));
    const res = await ownerPatch(
      req(`http://localhost/api/stay/bookings/${BOOKING_ID}`, 'PATCH', { refund_done: true }),
      routeParams(BOOKING_ID)
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/администрация платформы/);
    expect(clientQueryMock).not.toHaveBeenCalled();
  });

  it('администратор ставит refunded только у отменённой оплаченной брони', async () => {
    requireAuthMock.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
    clientQueryMock.mockImplementation(() => Promise.resolve({ rowCount: 1, rows: [{ id: BOOKING_ID }] }));
    const res = await ownerPatch(
      req(`http://localhost/api/stay/bookings/${BOOKING_ID}`, 'PATCH', { refund_done: true }),
      routeParams(BOOKING_ID)
    );
    expect(res.status).toBe(200);
    const [sql, params] = clientQueryMock.mock.calls[0];
    expect(String(sql)).toMatch(/SET payment_status = 'refunded'/);
    expect(String(sql)).toMatch(/b\.status = 'cancelled' AND b\.payment_status = 'paid'/);
    expect(params).toEqual([BOOKING_ID]);
  });

  it('нечего отмечать — 422, а не молчаливый успех', async () => {
    requireAuthMock.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
    clientQueryMock.mockImplementation(() => Promise.resolve({ rowCount: 0, rows: [] }));
    const res = await ownerPatch(
      req(`http://localhost/api/stay/bookings/${BOOKING_ID}`, 'PATCH', { refund_done: true }),
      routeParams(BOOKING_ID)
    );
    expect(res.status).toBe(422);
  });
});
