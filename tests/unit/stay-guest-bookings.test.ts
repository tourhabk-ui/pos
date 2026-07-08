/**
 * tests/unit/stay-guest-bookings.test.ts
 *
 * Гостевые брони жилья (цикл жизненного цикла, PR 2):
 * - GET /my скоупится строго по user_id;
 * - POST /cancel: гость отменяет свою будущую pending/confirmed → ok;
 *   прошедшую/терминальную → 422; чужую (0 строк по user_id) → 404;
 *   владелец объекта уведомляется при успехе.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

const clientQueryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  transaction: (cb: (c: { query: (...a: unknown[]) => unknown }) => unknown) =>
    cb({ query: (...a: unknown[]) => clientQueryMock(...a) }),
}));

const requireAuthMock = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}));

const notifyCancelMock = vi.fn();
vi.mock('@/lib/notifications/stay-booking', () => ({
  notifyStayBookingCancelled: (...args: unknown[]) => notifyCancelMock(...args),
}));

import { GET as getMy } from '@/app/api/stay/bookings/my/route';
import { POST as cancelBooking } from '@/app/api/stay/bookings/[id]/cancel/route';

const BOOKING_ID = '44444444-4444-4444-8444-444444444444';

function req(url: string, method: string): NextRequest {
  return new Request(url, { method }) as unknown as NextRequest;
}
const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  poolQueryMock.mockReset();
  clientQueryMock.mockReset();
  requireAuthMock.mockReset();
  notifyCancelMock.mockReset();
  requireAuthMock.mockResolvedValue({ userId: 'guest-1', role: 'tourist' });
});

describe('GET /api/stay/bookings/my', () => {
  it('скоупится по user_id гостя', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    const res = await getMy(req('http://localhost/api/stay/bookings/my', 'GET'));
    expect(res.status).toBe(200);

    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(String(sql)).toContain('WHERE b.user_id = $1');
    expect(params).toEqual(['guest-1']);
  });
});

describe('POST /api/stay/bookings/[id]/cancel', () => {
  it('будущая pending → cancelled + уведомление владельцу', async () => {
    clientQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('FOR UPDATE OF b')) {
        return Promise.resolve({ rows: [{
          status: 'pending', is_future: true,
          check_in_date: '2099-08-01', check_out_date: '2099-08-03',
          accommodation_name: 'Дом', owner_chat: 'owner-1',
        }] });
      }
      if (sql.includes('UPDATE accommodation_bookings')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await cancelBooking(req(`http://localhost/api/stay/bookings/${BOOKING_ID}/cancel`, 'POST'), routeParams(BOOKING_ID));
    expect(res.status).toBe(200);
    // ownership строго по user_id
    const selectCall = clientQueryMock.mock.calls.find(([sql]) => String(sql).includes('FOR UPDATE OF b'))!;
    expect(String(selectCall[0])).toContain('b.user_id = $2');
    expect(selectCall[1]).toEqual([BOOKING_ID, 'guest-1']);
    expect(notifyCancelMock).toHaveBeenCalledTimes(1);
  });

  it('прошедшая бронь → 422, статус не меняется', async () => {
    clientQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('FOR UPDATE OF b')) {
        return Promise.resolve({ rows: [{
          status: 'confirmed', is_future: false,
          check_in_date: '2020-01-01', check_out_date: '2020-01-03',
          accommodation_name: 'Дом', owner_chat: null,
        }] });
      }
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await cancelBooking(req(`http://localhost/api/stay/bookings/${BOOKING_ID}/cancel`, 'POST'), routeParams(BOOKING_ID));
    expect(res.status).toBe(422);
    expect(clientQueryMock.mock.calls.some(([sql]) => String(sql).includes('UPDATE accommodation_bookings'))).toBe(false);
    expect(notifyCancelMock).not.toHaveBeenCalled();
  });

  it('completed → 422 (терминальный)', async () => {
    clientQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('FOR UPDATE OF b')) {
        return Promise.resolve({ rows: [{
          status: 'completed', is_future: true,
          check_in_date: '2099-08-01', check_out_date: '2099-08-03',
          accommodation_name: 'Дом', owner_chat: null,
        }] });
      }
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await cancelBooking(req(`http://localhost/api/stay/bookings/${BOOKING_ID}/cancel`, 'POST'), routeParams(BOOKING_ID));
    expect(res.status).toBe(422);
  });

  it('чужая бронь (0 строк по user_id) → 404', async () => {
    clientQueryMock.mockResolvedValue({ rows: [] });
    const res = await cancelBooking(req(`http://localhost/api/stay/bookings/${BOOKING_ID}/cancel`, 'POST'), routeParams(BOOKING_ID));
    expect(res.status).toBe(404);
  });

  it('некорректный id → 400', async () => {
    const res = await cancelBooking(req('http://localhost/api/stay/bookings/xxx/cancel', 'POST'), routeParams('xxx'));
    expect(res.status).toBe(400);
  });
});
