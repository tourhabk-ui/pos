/**
 * tests/unit/stay-refund.test.ts
 *
 * Честный возврат при отмене жилья (PR 1 цикла возвратов):
 * - политика calculateStayRefund по всем тирам;
 * - гостевой cancel оплаченной брони → payment_status refunded/partially_refunded
 *   + refund_amount + уведомление владельцу с суммой;
 * - неоплаченной (pending) → без смены payment_status, без суммы;
 * - владельческий PATCH оплаченной брони в cancelled → 100%.
 * Физический возврат по CloudPayments — офлайн (в коде не эмулируется).
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

  it('гость 24–48ч → 50% (floor)', () => {
    const r = calculateStayRefund(9999, future(36), false);
    expect(r.percent).toBe(50);
    expect(r.amount).toBe(4999); // floor(9999*0.5)
  });

  it('гость <24ч → 0%', () => {
    const r = calculateStayRefund(10000, future(5), false);
    expect(r.percent).toBe(0);
    expect(r.amount).toBe(0);
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
vi.mock('@/lib/notifications/stay-booking', () => ({
  notifyStayBookingCancelled: (...args: unknown[]) => notifyCancelMock(...args),
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

  it('оплаченная будущая (>48ч) → payment_status=refunded, refund_amount=total, notify с суммой', async () => {
    selectRow({
      status: 'confirmed', payment_status: 'paid', total_price: '20000',
      is_future: true, check_in_date: farFuture, check_out_date: farFuture,
      accommodation_name: 'Дом', owner_chat: 'owner-1',
    });
    const res = await cancelBooking(req(`http://localhost/api/stay/bookings/${BOOKING_ID}/cancel`, 'POST'), routeParams(BOOKING_ID));
    expect(res.status).toBe(200);

    const updateCall = clientQueryMock.mock.calls.find(([sql]) => String(sql).includes('UPDATE accommodation_bookings'))!;
    // params: [id, refund_amount, refund_percent, refund_reason, nextPaymentStatus]
    expect(updateCall[1][1]).toBe(20000);
    expect(updateCall[1][2]).toBe(100);
    expect(updateCall[1][4]).toBe('refunded');

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
    expect(updateCall[1][4]).toBeNull();       // nextPaymentStatus → COALESCE не тронет
    expect(notifyCancelMock.mock.calls[0][0].wasPaid).toBe(false);
  });
});

describe('PATCH /[id] — отмена владельцем оплаченной брони → 100%', () => {
  it('confirmed(paid) → cancelled: payment_status=refunded, notify byOwner', async () => {
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
    // params: [nextStatus, id, refund_amount, refund_percent, refund_reason, nextPaymentStatus]
    expect(updateCall[1][2]).toBe(15000);
    expect(updateCall[1][3]).toBe(100);
    expect(updateCall[1][5]).toBe('refunded');

    expect(notifyCancelMock).toHaveBeenCalledTimes(1);
    expect(notifyCancelMock.mock.calls[0][0].byOwner).toBe(true);
    expect(notifyCancelMock.mock.calls[0][0].refundAmount).toBe(15000);
  });
});
