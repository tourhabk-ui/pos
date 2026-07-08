/**
 * tests/unit/stay-rates-rooms.test.ts
 *
 * Тарифный календарь и CRUD номеров жилья (миграция 721):
 * - POST /api/stay/calendar — upsert по (accommodation_id, date) уровня
 *   объекта и по (accommodation_id, room_id, date) уровня номера;
 *   чужой объект → 404;
 * - CRUD номеров: создание с Zod-валидацией, чужой номер → 404,
 *   DELETE с активными бронями → 409, с историей → деактивация;
 * - публичный prices: override применяется, без override — базовая цена,
 *   выдуманных множителей (×1.2 по выходным) больше нет.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
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

// Гвард повторяет форму requireAccommodationAccess: auth → ownership → 404
const verifyOwnershipMock = vi.fn();
vi.mock('@/lib/auth/stay-helpers', () => ({
  verifyAccommodationOwnership: (...args: unknown[]) => verifyOwnershipMock(...args),
  getStayPartnerId: vi.fn(),
  requireAccommodationAccess: async (request: unknown, accommodationId: string) => {
    const auth = await requireAuthMock(request);
    if (auth instanceof NextResponse) return auth;
    const isOwner = await verifyOwnershipMock(auth.userId, accommodationId);
    if (!isOwner && auth.role !== 'admin') {
      return NextResponse.json({ success: false, error: 'Объект не найден или нет прав' }, { status: 404 });
    }
    return auth;
  },
}));

import { GET as getCalendar, POST as postCalendar } from '@/app/api/stay/calendar/route';
import { GET as getRooms, POST as postRoom } from '@/app/api/stay/accommodations/[id]/rooms/route';
import { PATCH as patchRoom, DELETE as deleteRoom } from '@/app/api/stay/rooms/[id]/route';
import { GET as getPrices } from '@/app/api/accommodations/[id]/prices/route';
import { POST as postBooking } from '@/app/api/accommodations/[id]/book/route';

const ACC_ID = '33333333-3333-4333-8333-333333333333';
const ROOM_ID = '55555555-5555-4555-8555-555555555555';

function jsonReq(url: string, method: string, body?: unknown): NextRequest {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }) as unknown as NextRequest;
}

const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  poolQueryMock.mockReset();
  queryMock.mockReset();
  requireAuthMock.mockReset();
  verifyOwnershipMock.mockReset();
  requireAuthMock.mockResolvedValue({ userId: 'user-1', email: 'o@x.ru', role: 'stay' });
  verifyOwnershipMock.mockResolvedValue(true);
});

describe('POST /api/stay/calendar — upsert тарифа', () => {
  it('уровень объекта: ON CONFLICT по (accommodation_id, date) WHERE room_id IS NULL', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ id: '1', date: '2099-08-01', room_id: null }] });

    const res = await postCalendar(jsonReq('http://localhost/api/stay/calendar', 'POST', {
      accommodationId: ACC_ID,
      date: '2099-08-01',
      priceOverride: 12000,
    }));
    expect(res.status).toBe(200);

    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(String(sql)).toContain('ON CONFLICT (accommodation_id, date) WHERE room_id IS NULL');
    expect(params).toContain(12000);
  });

  it('уровень номера: проверка принадлежности номера + конфликт по room_id', async () => {
    poolQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM accommodation_rooms')) return Promise.resolve({ rows: [{ '?column?': 1 }] });
      return Promise.resolve({ rows: [{ id: '2', date: '2099-08-01', room_id: ROOM_ID }] });
    });

    const res = await postCalendar(jsonReq('http://localhost/api/stay/calendar', 'POST', {
      accommodationId: ACC_ID,
      roomId: ROOM_ID,
      date: '2099-08-01',
      isBlocked: true,
      blockReason: 'Ремонт',
    }));
    expect(res.status).toBe(200);

    const upsert = poolQueryMock.mock.calls.find(([sql]) =>
      String(sql).includes('ON CONFLICT (accommodation_id, room_id, date)'))!;
    expect(String(upsert[0])).toContain('WHERE room_id IS NOT NULL');
  });

  it('чужой объект → 404, ничего не пишется', async () => {
    verifyOwnershipMock.mockResolvedValue(false);

    const res = await postCalendar(jsonReq('http://localhost/api/stay/calendar', 'POST', {
      accommodationId: ACC_ID,
      date: '2099-08-01',
      priceOverride: 100,
    }));
    expect(res.status).toBe(404);
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('невалидная дата → 400', async () => {
    const res = await postCalendar(jsonReq('http://localhost/api/stay/calendar', 'POST', {
      accommodationId: ACC_ID,
      date: '01.08.2099',
    }));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/stay/calendar', () => {
  it('отдаёт тарифы, занятость и базовую цену', async () => {
    poolQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM accommodation_availability')) {
        return Promise.resolve({ rows: [{ id: '1', room_id: null, date: '2099-08-01', price_override: '15000', available_rooms: null, is_blocked: false, block_reason: null, notes: null }] });
      }
      if (sql.includes('generate_series')) {
        return Promise.resolve({ rows: [{ date: '2099-08-01', booked: 2 }] });
      }
      if (sql.includes('FROM accommodations')) {
        return Promise.resolve({ rows: [{ price_per_night_from: '8000', total_rooms: 10 }] });
      }
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await getCalendar(jsonReq(
      `http://localhost/api/stay/calendar?accommodationId=${ACC_ID}&startDate=2099-08-01&endDate=2099-08-31`, 'GET'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.basePrice).toBe(8000);
    expect(body.data.rates[0].priceOverride).toBe(15000);
    expect(body.data.occupancy[0].booked).toBe(2);
  });
});

describe('CRUD номеров', () => {
  it('POST создаёт номер, Zod отбрасывает неизвестный тип', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ id: ROOM_ID, name: 'Стандарт', room_type: 'double', is_active: true }] });

    const ok = await postRoom(jsonReq(`http://localhost/api/stay/accommodations/${ACC_ID}/rooms`, 'POST', {
      name: 'Стандарт', roomType: 'double', maxGuests: 2, availableRooms: 3, pricePerNight: 9000,
    }), routeParams(ACC_ID));
    expect(ok.status).toBe(201);

    const bad = await postRoom(jsonReq(`http://localhost/api/stay/accommodations/${ACC_ID}/rooms`, 'POST', {
      name: 'X', roomType: 'penthouse', maxGuests: 2, availableRooms: 1, pricePerNight: 100,
    }), routeParams(ACC_ID));
    expect(bad.status).toBe(400);
  });

  it('чужой номер → 404 без изменений', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ id: ROOM_ID, accommodation_id: ACC_ID, user_id: 'other-user' }] });

    const res = await patchRoom(jsonReq(`http://localhost/api/stay/rooms/${ROOM_ID}`, 'PATCH', { pricePerNight: 1 }),
      routeParams(ROOM_ID));
    expect(res.status).toBe(404);
    expect(poolQueryMock.mock.calls.some(([sql]) => String(sql).includes('UPDATE'))).toBe(false);
  });

  it('DELETE с активными бронями → 409', async () => {
    poolQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('JOIN partners')) return Promise.resolve({ rows: [{ id: ROOM_ID, accommodation_id: ACC_ID, user_id: 'user-1' }] });
      if (sql.includes('FILTER')) return Promise.resolve({ rows: [{ active: 2, total: 3 }] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await deleteRoom(jsonReq(`http://localhost/api/stay/rooms/${ROOM_ID}`, 'DELETE'), routeParams(ROOM_ID));
    expect(res.status).toBe(409);
    expect(poolQueryMock.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM'))).toBe(false);
  });

  it('DELETE с историей броней → деактивация вместо удаления', async () => {
    poolQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('JOIN partners')) return Promise.resolve({ rows: [{ id: ROOM_ID, accommodation_id: ACC_ID, user_id: 'user-1' }] });
      if (sql.includes('FILTER')) return Promise.resolve({ rows: [{ active: 0, total: 5 }] });
      if (sql.includes('UPDATE accommodation_rooms')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await deleteRoom(jsonReq(`http://localhost/api/stay/rooms/${ROOM_ID}`, 'DELETE'), routeParams(ROOM_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.deactivated).toBe(true);
    expect(poolQueryMock.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM'))).toBe(false);
  });

  it('DELETE без броней → удаление строки', async () => {
    poolQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('JOIN partners')) return Promise.resolve({ rows: [{ id: ROOM_ID, accommodation_id: ACC_ID, user_id: 'user-1' }] });
      if (sql.includes('FILTER')) return Promise.resolve({ rows: [{ active: 0, total: 0 }] });
      if (sql.includes('DELETE FROM accommodation_rooms')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await deleteRoom(jsonReq(`http://localhost/api/stay/rooms/${ROOM_ID}`, 'DELETE'), routeParams(ROOM_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.deleted).toBe(true);
  });

  it('GET rooms для чужого объекта → 404', async () => {
    verifyOwnershipMock.mockResolvedValue(false);
    const res = await getRooms(jsonReq(`http://localhost/api/stay/accommodations/${ACC_ID}/rooms`, 'GET'),
      routeParams(ACC_ID));
    expect(res.status).toBe(404);
    expect(poolQueryMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/accommodations/[id]/prices — честные цены', () => {
  it('override применяется, без override базовая цена, множителей нет', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM accommodations')) {
        return Promise.resolve({ rows: [{ id: ACC_ID, name: 'Дом', price_per_night_from: '8000', is_active: true }] });
      }
      if (sql.includes('generate_series')) {
        return Promise.resolve({ rows: [
          { date: '2099-08-01', price: '8000', has_override: false, is_blocked: false },
          { date: '2099-08-02', price: '12000', has_override: true, is_blocked: false },
        ] });
      }
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await getPrices(
      jsonReq(`http://localhost/api/accommodations/${ACC_ID}/prices?startDate=2099-08-01&endDate=2099-08-02`, 'GET'),
      routeParams(ACC_ID)
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.prices).toEqual([
      { date: '2099-08-01', price: 8000, type: 'base', isBlocked: false },
      { date: '2099-08-02', price: 12000, type: 'override', isBlocked: false },
    ]);

    // Выдуманная «динамика» удалена: ни множителей, ни peak-типов в SQL
    const allSql = queryMock.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(allSql).not.toContain('1.2');
    expect(allSql).not.toContain('peak');
    expect(allSql).toContain('accommodation_availability');
  });
});

describe('POST /api/accommodations/[id]/book — календарь владельца учитывается', () => {
  const ROOM_ROW = {
    id: ROOM_ID, accommodation_id: ACC_ID, name: 'Стандарт', max_guests: 4,
    available_rooms: 3, price_per_night: '9000', accommodation_name: 'Дом', is_active: true,
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  });

  function mockBookingQueries(rates: unknown[]) {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM accommodation_rooms r')) return Promise.resolve({ rows: [ROOM_ROW] });
      if (sql.includes('COUNT(*) as bookings')) return Promise.resolve({ rows: [{ bookings: '0' }] });
      if (sql.includes('FROM accommodation_availability')) return Promise.resolve({ rows: rates });
      if (sql.includes('INSERT INTO accommodation_bookings')) return Promise.resolve({ rows: [{ id: 'booking-1' }] });
      if (sql.includes('FROM users')) return Promise.resolve({ rows: [{ email: null, name: 'Гость' }] });
      throw new Error('unexpected SQL: ' + sql);
    });
  }

  it('дата закрыта владельцем → 409, бронь не создаётся', async () => {
    mockBookingQueries([{ date: '2099-08-02', room_id: null, price_override: null, is_blocked: true }]);

    const res = await postBooking(jsonReq(`http://localhost/api/accommodations/${ACC_ID}/book`, 'POST', {
      roomId: ROOM_ID, checkInDate: '2099-08-01', checkOutDate: '2099-08-03', adults: 2,
    }), routeParams(ACC_ID));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('закрыл продажу');
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO accommodation_bookings'))).toBe(false);
  });

  it('override владельца попадает в цену брони (номер > объект > базовая)', async () => {
    mockBookingQueries([
      { date: '2099-08-01', room_id: null, price_override: '12000', is_blocked: false },
      { date: '2099-08-01', room_id: ROOM_ID, price_override: '15000', is_blocked: false },
    ]);

    const res = await postBooking(jsonReq(`http://localhost/api/accommodations/${ACC_ID}/book`, 'POST', {
      roomId: ROOM_ID, checkInDate: '2099-08-01', checkOutDate: '2099-08-03', adults: 2,
    }), routeParams(ACC_ID));

    expect(res.status).toBe(200);
    const body = await res.json();
    // Ночь 1: room-override 15000; ночь 2: базовая 9000 → 24000
    expect(body.data.priceBreakdown.totalPrice).toBe(24000);

    const insert = queryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO accommodation_bookings'))!;
    expect(insert[1]).toContain(24000);
  });

  it('без тарифов — базовая цена за все ночи', async () => {
    mockBookingQueries([]);

    const res = await postBooking(jsonReq(`http://localhost/api/accommodations/${ACC_ID}/book`, 'POST', {
      roomId: ROOM_ID, checkInDate: '2099-08-01', checkOutDate: '2099-08-03', adults: 2,
    }), routeParams(ACC_ID));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.priceBreakdown.totalPrice).toBe(18000);
  });
});
