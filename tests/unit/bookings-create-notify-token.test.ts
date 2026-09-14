/**
 * tests/unit/bookings-create-notify-token.test.ts
 *
 * #1889: ключ доступа к брони (`access_token`) уходил письмом ОДНОЙ веткой —
 * `if (data.tourist_email)`. В Telegram-уведомление туристу ключ не попадал
 * вовсе, хотя канал доставки уже есть (notifyTouristBookingCreated зовётся
 * для каждого авторизованного пользователя). Без ключа ссылка «Перейти к
 * оплате» в сообщении вела бы в тупик.
 *
 * Контракт: авторизованный турист → notifyTouristBookingCreated получает
 * accessToken; гость → функция не зовётся вовсе (не привязано к этому issue,
 * старое поведение, проверено попутно).
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

vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: () => ({ check: () => true }),
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

const getUserFromRequestMock = vi.fn();
vi.mock('@/lib/auth/jwt', () => ({
  getUserFromRequest: (req: unknown) => getUserFromRequestMock(req),
}));

const notifyTouristBookingCreatedMock = vi.fn();
vi.mock('@/lib/telegram/booking-notify', () => ({
  notifyTouristBookingCreated: (...args: unknown[]) => notifyTouristBookingCreatedMock(...args),
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
    // Календарь и занятость — одним запросом по дням диапазона (14.09).
    if (sql.includes('generate_series')) {
      return Promise.resolve({ rows: [{ date: '2099-01-01', occupied: '0', available_slots: null, is_cancelled: null }] });
    }
    if (sql.includes('INSERT INTO operator_bookings')) {
      return Promise.resolve({ rows: [{ id: 42, access_token: 'test-access-token-abc' }] });
    }
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
  mockHappyPathQueries();
});

describe('POST /api/hub/bookings/create — accessToken доезжает до Telegram-уведомления', () => {
  it('авторизованный турист: notifyTouristBookingCreated получает accessToken из брони', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 'user-123', email: 'a@b.com', role: 'tourist' });

    const res = await POST(postReq(VALID_BODY, { Authorization: 'Bearer faketoken' }));
    expect(res.status).toBe(200);

    expect(notifyTouristBookingCreatedMock).toHaveBeenCalledTimes(1);
    const [userId, booking] = notifyTouristBookingCreatedMock.mock.calls[0]!;
    expect(userId).toBe('user-123');
    expect((booking as { accessToken?: string }).accessToken).toBe('test-access-token-abc');
  });

  it('гость без токена: notifyTouristBookingCreated не зовётся вовсе', async () => {
    getUserFromRequestMock.mockResolvedValue(null);

    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(200);
    expect(notifyTouristBookingCreatedMock).not.toHaveBeenCalled();
  });
});
