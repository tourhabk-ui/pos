/**
 * tests/unit/bookings-create-capacity.test.ts
 *
 * POST /api/hub/bookings/create — гейткипер уважает календарь оператора
 * (унификация моделей вместимости, карта функционала):
 * - нет строки tour_availability на дату → поведение как раньше
 *   (календарь опционален, cap = max_participants);
 * - is_cancelled → 422 DATE_BLOCKED, INSERT не вызывается;
 * - available_slots < max_participants → эффективный cap по календарю.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const clientQueryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  transaction: (cb: (client: { query: (...args: unknown[]) => unknown }) => unknown) =>
    cb({ query: (...args: unknown[]) => clientQueryMock(...args) }),
}));

vi.mock('@/lib/db-pool', () => ({
  pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
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
vi.mock('@/lib/auth/jwt', () => ({
  verifyToken: vi.fn().mockResolvedValue(null),
  extractToken: () => null,
}));

import { POST } from '@/app/api/hub/bookings/create/route';

const TOUR_ROW = {
  operator_id: 'op-1',
  title: 'Восхождение на Авачинский',
  base_price: 5000,
  max_participants: 10,
  available_slots: null,
};

interface CalendarRow { available_slots: number; is_cancelled: boolean }

function mockQueries(opts: { calendar: CalendarRow[]; alreadyBooked?: string }) {
  clientQueryMock.mockImplementation((sql: string) => {
    if (sql.includes('FROM operator_tours')) return Promise.resolve({ rows: [TOUR_ROW] });
    if (sql.includes('FROM tour_availability')) return Promise.resolve({ rows: opts.calendar });
    if (sql.includes('already_booked')) return Promise.resolve({ rows: [{ already_booked: opts.alreadyBooked ?? '0' }] });
    if (sql.includes('INSERT INTO operator_bookings')) return Promise.resolve({ rows: [{ id: 42 }] });
    throw new Error('unexpected SQL: ' + sql);
  });
}

function postReq(participants: number): NextRequest {
  const req = new Request('http://localhost/api/hub/bookings/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tour_id: 1,
      tourist_name: 'Иван Иванов',
      tourist_phone: '+79991234567',
      participants_count: participants,
      booking_date: '2099-01-01',
    }),
  });
  (req as unknown as { cookies: { get: () => undefined } }).cookies = { get: () => undefined };
  return req as unknown as NextRequest;
}

function insertCalled(): boolean {
  return clientQueryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO operator_bookings'));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/hub/bookings/create — календарь оператора', () => {
  it('нет строки календаря → бронь проходит, cap = max_participants (как раньше)', async () => {
    mockQueries({ calendar: [] });
    const res = await POST(postReq(2));
    expect(res.status).toBe(200);
    expect(insertCalled()).toBe(true);
  });

  it('дата заблокирована оператором (is_cancelled) → 422 DATE_BLOCKED, INSERT не вызван', async () => {
    mockQueries({ calendar: [{ available_slots: 10, is_cancelled: true }] });
    const res = await POST(postReq(2));
    const json = await res.json();

    expect(res.status).toBe(422);
    expect(json.error).toContain('закрыл бронирование');
    expect(insertCalled()).toBe(false);
  });

  it('календарь ограничивает: available_slots=3 < max_participants=10, занято 2 → 2 участника отклонены', async () => {
    mockQueries({ calendar: [{ available_slots: 3, is_cancelled: false }], alreadyBooked: '2' });
    const res = await POST(postReq(2));
    const json = await res.json();

    expect(res.status).toBe(422);
    expect(json.error).toContain('Доступно: 1');
    expect(insertCalled()).toBe(false);
  });

  it('календарь ограничивает, но место есть: занято 2 из 3 → 1 участник проходит', async () => {
    mockQueries({ calendar: [{ available_slots: 3, is_cancelled: false }], alreadyBooked: '2' });
    const res = await POST(postReq(1));
    expect(res.status).toBe(200);
    expect(insertCalled()).toBe(true);
  });

  it('запрос больше лимита календаря → MAX_EXCEEDED с эффективным капом', async () => {
    mockQueries({ calendar: [{ available_slots: 3, is_cancelled: false }] });
    const res = await POST(postReq(5));
    const json = await res.json();

    expect(res.status).toBe(422);
    expect(json.error).toContain('максимум: 3');
    expect(insertCalled()).toBe(false);
  });
});
