/**
 * tests/unit/bookings-create-user-id.test.ts
 *
 * POST /api/hub/bookings/create — booking-БАГ: user_id никогда не проставлялся
 * при создании брони, из-за чего lib/recommendations/engine.ts всегда получал
 * пустую историю и показывал одинаковый fallback всем пользователям.
 * Контракт: авторизованный юзер → user_id пишется; гость (без токена) →
 * user_id = null, поведение не меняется (гостевой чек-аут остаётся рабочим).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const clientQueryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  transaction: (cb: (client: { query: (...args: unknown[]) => unknown }) => unknown) =>
    cb({ query: (...args: unknown[]) => clientQueryMock(...args) }),
}));

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

const rateCheckMock = vi.fn(() => true);
vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: () => ({ check: (ip: string) => rateCheckMock(ip) }),
  getClientIp: () => '10.0.0.1',
}));

vi.mock('@/lib/notifications/operator-booking', () => ({
  notifyNewBooking: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/notifications/email-service', () => ({
  emailService: { sendEmail: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/lib/integrations/uon', () => ({
  createUonRequest: vi.fn().mockResolvedValue(null),
}));

const verifyTokenMock = vi.fn();
vi.mock('@/lib/auth/jwt', () => ({
  verifyToken: (token: string) => verifyTokenMock(token),
  extractToken: (header: string | null) =>
    header?.toLowerCase().startsWith('bearer ') ? header.slice(7) : null,
}));

import { POST } from '@/app/api/hub/bookings/create/route';

const TOUR_ROW = {
  operator_id: 'op-1',
  title: 'Восхождение на Авачинский',
  base_price: 5000,
  max_participants: 10,
  available_slots: 10,
};

function mockHappyPathQueries() {
  clientQueryMock.mockImplementation((sql: string) => {
    if (sql.includes('FROM operator_tours')) return Promise.resolve({ rows: [TOUR_ROW] });
    if (sql.includes('FROM tour_availability')) return Promise.resolve({ rows: [] }); // календарь не заполнен
    if (sql.includes('already_booked')) return Promise.resolve({ rows: [{ already_booked: '0' }] });
    if (sql.includes('INSERT INTO operator_bookings')) return Promise.resolve({ rows: [{ id: 42 }] });
    throw new Error('unexpected SQL: ' + sql);
  });
  poolQueryMock.mockResolvedValue({ rows: [{ name: 'Operator', telegram_chat_id: null, max_chat_id: null, uon_api_key: null }] });
}

function postReq(body: unknown, headers: Record<string, string> = {}): NextRequest {
  const req = new Request('http://localhost/api/hub/bookings/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  // NextRequest augments Request with .cookies — plain Request doesn't have it.
  (req as unknown as { cookies: { get: () => undefined } }).cookies = { get: () => undefined };
  return req as unknown as NextRequest;
}

const VALID_BODY = {
  tour_id: 1,
  tourist_name: 'Иван Иванов',
  tourist_phone: '+79991234567',
  participants_count: 2,
  booking_date: '2099-01-01',
};

beforeEach(() => {
  vi.clearAllMocks();
  rateCheckMock.mockReturnValue(true);
  mockHappyPathQueries();
});

describe('POST /api/hub/bookings/create — user_id linkage', () => {
  it('авторизованный юзер → user_id пишется в INSERT', async () => {
    verifyTokenMock.mockResolvedValue({ userId: 'user-123', email: 'a@b.com', role: 'tourist' });

    const res = await POST(postReq(VALID_BODY, { Authorization: 'Bearer faketoken' }));
    expect(res.status).toBe(200);

    const insertCall = clientQueryMock.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO operator_bookings'));
    expect(insertCall).toBeTruthy();
    const [, params] = insertCall as [string, unknown[]];
    expect(params[params.length - 1]).toBe('user-123');
  });

  it('гость без токена → user_id = null, бронь всё равно создаётся', async () => {
    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(200);
    expect(verifyTokenMock).not.toHaveBeenCalled();

    const insertCall = clientQueryMock.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO operator_bookings'));
    expect(insertCall).toBeTruthy();
    const [, params] = insertCall as [string, unknown[]];
    expect(params[params.length - 1]).toBeNull();
  });

  it('невалидный/просроченный токен → user_id = null (fail-open, не 401)', async () => {
    verifyTokenMock.mockResolvedValue(null);

    const res = await POST(postReq(VALID_BODY, { Authorization: 'Bearer expired' }));
    expect(res.status).toBe(200);

    const insertCall = clientQueryMock.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO operator_bookings'));
    const [, params] = insertCall as [string, unknown[]];
    expect(params[params.length - 1]).toBeNull();
  });
});
