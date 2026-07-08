/**
 * tests/unit/stay-owner-api.test.ts
 *
 * Owner-API владельца жилья + фиксы битой публичной витрины (карта функционала):
 * - GET /api/stay/accommodations — листинг скоупится по partner_id;
 * - PATCH /api/accommodations/[id] — чужой объект невидим (404);
 * - PATCH /api/stay/bookings/[id] — переходы по жизненному циклу,
 *   невалидный → 422, чужая бронь → 404;
 * - фикс-эндпоинты витрины используют реальные колонки:
 *   check_in_date/check_out_date, price_per_night_from, accommodation_reviews.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const queryMock = vi.fn();
const clientQueryMock = vi.fn();

vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  transaction: (cb: (client: { query: (...args: unknown[]) => unknown }) => unknown) =>
    cb({ query: (...args: unknown[]) => clientQueryMock(...args) }),
}));

const requireAuthMock = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}));

vi.mock('@/lib/notifications/email-service', () => ({
  emailService: { sendEmail: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/lib/auth', () => ({
  getTokenFromRequest: () => null,
}));

import { GET as getMyAccommodations } from '@/app/api/stay/accommodations/route';
import { PATCH as patchAccommodation } from '@/app/api/accommodations/[id]/route';
import { GET as getStayBookings } from '@/app/api/stay/bookings/route';
import { PATCH as patchStayBooking } from '@/app/api/stay/bookings/[id]/route';
import { GET as getAvailability } from '@/app/api/accommodations/[id]/availability/route';
import { GET as getPrices } from '@/app/api/accommodations/[id]/prices/route';
import { GET as getBlockedDates } from '@/app/api/accommodations/[id]/blocked-dates/route';

const ACC_ID = '33333333-3333-4333-8333-333333333333';
const BOOKING_ID = '44444444-4444-4444-8444-444444444444';

function jsonReq(url: string, method: string, body?: unknown): NextRequest {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }) as unknown as NextRequest;
}

const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  queryMock.mockReset();
  clientQueryMock.mockReset();
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue({ userId: 'user-1', email: 'o@x.ru', role: 'stay' });
});

describe('GET /api/stay/accommodations', () => {
  it('без stay-профиля → 404', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM partners')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await getMyAccommodations(jsonReq('http://localhost/api/stay/accommodations', 'GET'));
    expect(res.status).toBe(404);
  });

  it('листинг скоупится по partner_id и включает неактивные', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM partners')) return Promise.resolve({ rows: [{ id: 'partner-1' }] });
      if (sql.includes('FROM accommodations a')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await getMyAccommodations(jsonReq('http://localhost/api/stay/accommodations', 'GET'));
    expect(res.status).toBe(200);

    const [listSql, listParams] = queryMock.mock.calls.find(([sql]) => String(sql).includes('FROM accommodations a'))!;
    expect(listSql).toContain('a.partner_id = $1');
    expect(listSql).not.toContain('a.is_active = true');
    expect(listParams).toEqual(['partner-1']);
  });
});

describe('PATCH /api/accommodations/[id]', () => {
  it('чужой объект → 404, UPDATE не выполняется', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM accommodations a')) return Promise.resolve({ rows: [] }); // ownership
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await patchAccommodation(
      jsonReq(`http://localhost/api/accommodations/${ACC_ID}`, 'PATCH', { name: 'Гостевой дом' }),
      routeParams(ACC_ID)
    );

    expect(res.status).toBe(404);
    const updates = queryMock.mock.calls.filter(([sql]) => String(sql).includes('UPDATE accommodations'));
    expect(updates).toHaveLength(0);
  });

  it('свой объект: частичный апдейт с is_active и price_per_night_from', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM accommodations a')) return Promise.resolve({ rows: [{ id: ACC_ID }] });
      if (sql.includes('UPDATE accommodations')) return Promise.resolve({ rows: [{ id: ACC_ID }] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await patchAccommodation(
      jsonReq(`http://localhost/api/accommodations/${ACC_ID}`, 'PATCH', { pricePerNightFrom: 4500, isActive: false }),
      routeParams(ACC_ID)
    );

    expect(res.status).toBe(200);
    const [updateSql] = queryMock.mock.calls.find(([sql]) => String(sql).includes('UPDATE accommodations'))!;
    expect(updateSql).toContain('price_per_night_from = $');
    expect(updateSql).toContain('is_active = $');
  });
});

describe('GET /api/stay/bookings', () => {
  it('брони только своих объектов (JOIN accommodations по partner_id)', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM partners')) return Promise.resolve({ rows: [{ id: 'partner-1' }] });
      if (sql.includes('FROM accommodation_bookings b')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await getStayBookings(jsonReq('http://localhost/api/stay/bookings?status=pending', 'GET'));
    expect(res.status).toBe(200);

    const [listSql] = queryMock.mock.calls.find(([sql]) => String(sql).includes('FROM accommodation_bookings b'))!;
    expect(listSql).toContain('JOIN accommodations a ON b.accommodation_id = a.id');
    expect(listSql).toContain('a.partner_id = $1');
  });

  it('некорректный статус фильтра → 400', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM partners')) return Promise.resolve({ rows: [{ id: 'partner-1' }] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await getStayBookings(jsonReq('http://localhost/api/stay/bookings?status=shipped', 'GET'));
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/stay/bookings/[id]', () => {
  function mockBookingRow(status: string | null) {
    clientQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: status ? [{ id: BOOKING_ID, status }] : [] });
      }
      if (sql.includes('UPDATE accommodation_bookings')) return Promise.resolve({ rows: [{ id: BOOKING_ID }] });
      throw new Error('unexpected SQL: ' + sql);
    });
  }

  beforeEach(() => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM partners')) return Promise.resolve({ rows: [{ id: 'partner-1' }] });
      throw new Error('unexpected SQL: ' + sql);
    });
  });

  it('чужая бронь (ownership в WHERE) → 404', async () => {
    mockBookingRow(null);

    const res = await patchStayBooking(
      jsonReq(`http://localhost/api/stay/bookings/${BOOKING_ID}`, 'PATCH', { status: 'confirmed' }),
      routeParams(BOOKING_ID)
    );
    expect(res.status).toBe(404);

    const [selectSql] = clientQueryMock.mock.calls.find(([sql]) => String(sql).includes('FOR UPDATE'))!;
    expect(selectSql).toContain('a.partner_id = $2');
  });

  it('pending → confirmed: 200', async () => {
    mockBookingRow('pending');

    const res = await patchStayBooking(
      jsonReq(`http://localhost/api/stay/bookings/${BOOKING_ID}`, 'PATCH', { status: 'confirmed' }),
      routeParams(BOOKING_ID)
    );
    expect(res.status).toBe(200);
  });

  it('confirmed → no_show: 200', async () => {
    mockBookingRow('confirmed');

    const res = await patchStayBooking(
      jsonReq(`http://localhost/api/stay/bookings/${BOOKING_ID}`, 'PATCH', { status: 'no_show' }),
      routeParams(BOOKING_ID)
    );
    expect(res.status).toBe(200);
  });

  it('cancelled → confirmed: терминальный статус, 422', async () => {
    mockBookingRow('cancelled');

    const res = await patchStayBooking(
      jsonReq(`http://localhost/api/stay/bookings/${BOOKING_ID}`, 'PATCH', { status: 'confirmed' }),
      routeParams(BOOKING_ID)
    );
    expect(res.status).toBe(422);
    const updates = clientQueryMock.mock.calls.filter(([sql]) => String(sql).includes('UPDATE accommodation_bookings'));
    expect(updates).toHaveLength(0);
  });
});

describe('фиксы битой публичной витрины', () => {
  const ACC_ROW = {
    id: ACC_ID, name: 'Гостиница «Вулкан»', total_rooms: '10',
    price_per_night_from: '5000', is_active: true,
  };

  it('availability читает check_in_date/check_out_date и price_per_night_from', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM accommodations')) return Promise.resolve({ rows: [ACC_ROW] });
      if (sql.includes('date_series')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await getAvailability(
      jsonReq(`http://localhost/api/accommodations/${ACC_ID}/availability?checkIn=2099-08-01&checkOut=2099-08-04`, 'GET'),
      routeParams(ACC_ID)
    );
    expect(res.status).toBe(200);

    const allSql = queryMock.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(allSql).toContain('ab.check_in_date');
    expect(allSql).toContain('ab.check_out_date');
    expect(allSql).toContain('price_per_night_from');
    expect(allSql).not.toContain('DATE(ab.check_in)');
  });

  it('prices читает price_per_night_from', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM accommodations')) return Promise.resolve({ rows: [ACC_ROW] });
      if (sql.includes('generate_series')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await getPrices(
      jsonReq(`http://localhost/api/accommodations/${ACC_ID}/prices?startDate=2099-08-01&endDate=2099-08-04`, 'GET'),
      routeParams(ACC_ID)
    );
    expect(res.status).toBe(200);

    const accSql = String(queryMock.mock.calls[0][0]);
    expect(accSql).toContain('price_per_night_from');
    expect(accSql).not.toMatch(/price_per_night[^_]/);
  });

  it('blocked-dates читает check_in_date/check_out_date', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM accommodations')) return Promise.resolve({ rows: [ACC_ROW] });
      if (sql.includes('date_series')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await getBlockedDates(
      jsonReq(`http://localhost/api/accommodations/${ACC_ID}/blocked-dates?startDate=2099-08-01&endDate=2099-08-04`, 'GET'),
      routeParams(ACC_ID)
    );
    expect(res.status).toBe(200);

    const allSql = queryMock.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(allSql).toContain('ab.check_in_date');
    expect(allSql).not.toContain('DATE(ab.check_in)');
  });
});
