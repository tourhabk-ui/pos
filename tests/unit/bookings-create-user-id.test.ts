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

// getUserFromRequest (не голый verifyToken) — с P1-фиксом отзыва сессии
// (аудит 28.08) роут сверяет ещё и user_sessions, поэтому мокается сама
// точка входа, а не низкоуровневая verifyToken.
const getUserFromRequestMock = vi.fn();
vi.mock('@/lib/auth/jwt', () => ({
  getUserFromRequest: (req: unknown) => getUserFromRequestMock(req),
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


/**
 * Значение колонки `user_id` в вызове INSERT — по имени колонки, не по месту
 * в массиве. Позиция параметра менялась (последним стал metadata), и проверка
 * «последний параметр» ловила бы не то поле, продолжая при этом зеленеть.
 */
function insertedValueOf(column: string): unknown {
  const call = clientQueryMock.mock.calls.find(([sql]) =>
    String(sql).includes('INSERT INTO operator_bookings'));
  expect(call, 'INSERT в operator_bookings не вызван').toBeTruthy();
  const [sql, params] = call as [string, unknown[]];

  const columns = /INSERT INTO operator_bookings\s*\(([^)]*)\)/i.exec(sql)?.[1];
  const values  = /VALUES\s*\(([^)]*)\)/i.exec(sql)?.[1];
  expect(columns, 'не разобран список колонок INSERT').toBeTruthy();
  expect(values, 'не разобран список значений INSERT').toBeTruthy();

  const names  = columns!.split(',').map(s => s.trim());
  const slots  = values!.split(',').map(s => s.trim());
  expect(names.length, 'колонок и значений разное число').toBe(slots.length);

  const at = names.indexOf(column);
  expect(at, `колонки ${column} нет в INSERT`).toBeGreaterThanOrEqual(0);
  const n = Number(/^\$(\d+)/.exec(slots[at]!)?.[1]);
  expect(Number.isFinite(n), `значение ${column} — не параметр: ${slots[at]}`).toBe(true);
  return params[n - 1];
}

beforeEach(() => {
  vi.clearAllMocks();
  rateCheckMock.mockReturnValue(true);
  mockHappyPathQueries();
});

describe('POST /api/hub/bookings/create — user_id linkage', () => {
  it('авторизованный юзер → user_id пишется в INSERT', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 'user-123', email: 'a@b.com', role: 'tourist' });

    const res = await POST(postReq(VALID_BODY, { Authorization: 'Bearer faketoken' }));
    expect(res.status).toBe(200);

    expect(insertedValueOf('user_id')).toBe('user-123');
  });

  it('гость без токена → user_id = null, бронь всё равно создаётся', async () => {
    getUserFromRequestMock.mockResolvedValue(null);

    const res = await POST(postReq(VALID_BODY));
    expect(res.status).toBe(200);

    expect(insertedValueOf('user_id')).toBeNull();
  });

  it('невалидный/просроченный/отозванный токен → user_id = null (fail-open, не 401)', async () => {
    // getUserFromRequest сам решает «нет» и для битой подписи, и для
    // валидной подписи с отозванной (signout) сессией — оба случая роуту
    // видны одинаково: null.
    getUserFromRequestMock.mockResolvedValue(null);

    const res = await POST(postReq(VALID_BODY, { Authorization: 'Bearer expired' }));
    expect(res.status).toBe(200);

    expect(insertedValueOf('user_id')).toBeNull();
  });
});
