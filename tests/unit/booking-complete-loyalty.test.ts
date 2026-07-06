/**
 * tests/unit/booking-complete-loyalty.test.ts
 *
 * PATCH /api/bookings/[id]/complete — начисление лояльности.
 * Контракт: при завершении брони туриста с суммой > 0 вызываются И
 * earnPoints (1% от суммы), И earnActivityPoints('first_booking') —
 * бонус, обещанный в UI лояльности, но раньше нигде не вызывавшийся
 * (аудит по карте функционала). Гостевая бронь (без tourist.id) — ни
 * одного вызова лояльности, как раньше.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const earnPointsMock = vi.fn().mockResolvedValue({ success: true });
const earnActivityPointsMock = vi.fn().mockResolvedValue({ success: true });
vi.mock('@/lib/loyalty/loyalty-system', () => ({
  loyaltySystem: {
    earnPoints: (...args: unknown[]) => earnPointsMock(...args),
    earnActivityPoints: (...args: unknown[]) => earnActivityPointsMock(...args),
  },
}));

const completeBookingMock = vi.fn();
vi.mock('@/lib/bookings/booking.service', () => ({
  completeBooking: (...args: unknown[]) => completeBookingMock(...args),
}));

vi.mock('@/lib/auth', () => ({
  verifyAuth: vi.fn().mockResolvedValue({
    isAuthenticated: true,
    userId: 'op-1',
    role: 'operator',
    email: 'op@example.com',
  }),
}));

import { PATCH } from '@/app/api/bookings/[id]/complete/route';

function patchReq(): NextRequest {
  return new Request('http://localhost/api/bookings/b-1/complete', { method: 'PATCH' }) as unknown as NextRequest;
}

const params = Promise.resolve({ id: 'b-1' });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PATCH /api/bookings/[id]/complete — лояльность', () => {
  it('бронь туриста с суммой > 0 → earnPoints И first_booking бонус', async () => {
    completeBookingMock.mockResolvedValue({ tourist: { id: 'user-7' }, totalAmount: 15000 });

    const res = await PATCH(patchReq(), { params });

    expect(res.status).toBe(200);
    expect(earnPointsMock).toHaveBeenCalledWith('user-7', 'b-1', 15000);
    expect(earnActivityPointsMock).toHaveBeenCalledWith('user-7', 'first_booking', 'b-1');
  });

  it('гостевая бронь (без tourist.id) → лояльность не трогается', async () => {
    completeBookingMock.mockResolvedValue({ tourist: null, totalAmount: 15000 });

    const res = await PATCH(patchReq(), { params });

    expect(res.status).toBe(200);
    expect(earnPointsMock).not.toHaveBeenCalled();
    expect(earnActivityPointsMock).not.toHaveBeenCalled();
  });

  it('сбой начисления лояльности не ломает ответ (fire-and-forget)', async () => {
    completeBookingMock.mockResolvedValue({ tourist: { id: 'user-7' }, totalAmount: 15000 });
    earnPointsMock.mockRejectedValue(new Error('db down'));
    earnActivityPointsMock.mockRejectedValue(new Error('db down'));

    const res = await PATCH(patchReq(), { params });

    expect(res.status).toBe(200);
  });
});
