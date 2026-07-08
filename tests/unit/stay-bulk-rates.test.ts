/**
 * tests/unit/stay-bulk-rates.test.ts
 *
 * Массовое задание тарифов жилья (POST /api/stay/calendar/bulk):
 * - upsert диапазоном через generate_series с фильтром дней недели;
 * - обновляются только переданные поля (семантика поштучного POST);
 * - чужой объект → 404 без записи; пустой набор полей → 400;
 * - диапазон больше года → 400.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

const requireAuthMock = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}));

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

import { POST as postBulk } from '@/app/api/stay/calendar/bulk/route';

const ACC_ID = '33333333-3333-4333-8333-333333333333';
const ROOM_ID = '55555555-5555-4555-8555-555555555555';

function jsonReq(body: unknown): NextRequest {
  return new Request('http://localhost/api/stay/calendar/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  poolQueryMock.mockReset();
  requireAuthMock.mockReset();
  verifyOwnershipMock.mockReset();
  requireAuthMock.mockResolvedValue({ userId: 'user-1', role: 'stay' });
  verifyOwnershipMock.mockResolvedValue(true);
});

describe('POST /api/stay/calendar/bulk', () => {
  it('уровень объекта: generate_series + конфликт по (accommodation_id, date), только переданные поля', async () => {
    poolQueryMock.mockResolvedValue({ rowCount: 31, rows: [] });

    const res = await postBulk(jsonReq({
      accommodationId: ACC_ID,
      startDate: '2099-08-01',
      endDate: '2099-08-31',
      priceOverride: 12000,
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.daysAffected).toBe(31);

    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(String(sql)).toContain('generate_series($3::date, $4::date');
    expect(String(sql)).toContain('ON CONFLICT (accommodation_id, date) WHERE room_id IS NULL');
    // Только price_override — is_blocked/notes не затираются
    expect(String(sql)).toContain('price_override = EXCLUDED.price_override');
    expect(String(sql)).not.toContain('is_blocked = EXCLUDED');
    expect(params).toContain(12000);
  });

  it('дни недели фильтруются через EXTRACT(DOW) = ANY', async () => {
    poolQueryMock.mockResolvedValue({ rowCount: 8, rows: [] });

    const res = await postBulk(jsonReq({
      accommodationId: ACC_ID,
      startDate: '2099-08-01',
      endDate: '2099-08-31',
      weekdays: [5, 6], // пт, сб
      priceOverride: 15000,
    }));
    expect(res.status).toBe(200);

    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(String(sql)).toContain('EXTRACT(DOW FROM d.date)::int = ANY');
    expect(params.some((p: unknown) => Array.isArray(p) && p.includes(5) && p.includes(6))).toBe(true);
  });

  it('уровень номера: проверка принадлежности + конфликт по room_id', async () => {
    poolQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM accommodation_rooms')) return Promise.resolve({ rows: [{ '?column?': 1 }] });
      return Promise.resolve({ rowCount: 10, rows: [] });
    });

    const res = await postBulk(jsonReq({
      accommodationId: ACC_ID,
      roomId: ROOM_ID,
      startDate: '2099-08-01',
      endDate: '2099-08-10',
      isBlocked: true,
    }));
    expect(res.status).toBe(200);

    const upsert = poolQueryMock.mock.calls.find(([sql]) => String(sql).includes('generate_series'))!;
    expect(String(upsert[0])).toContain('ON CONFLICT (accommodation_id, room_id, date) WHERE room_id IS NOT NULL');
  });

  it('чужой объект → 404, ничего не пишется', async () => {
    verifyOwnershipMock.mockResolvedValue(false);
    const res = await postBulk(jsonReq({
      accommodationId: ACC_ID, startDate: '2099-08-01', endDate: '2099-08-31', priceOverride: 1,
    }));
    expect(res.status).toBe(404);
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('без полей → 400; диапазон больше года → 400; endDate < startDate → 400', async () => {
    const noFields = await postBulk(jsonReq({
      accommodationId: ACC_ID, startDate: '2099-08-01', endDate: '2099-08-31',
    }));
    expect(noFields.status).toBe(400);

    const tooLong = await postBulk(jsonReq({
      accommodationId: ACC_ID, startDate: '2099-01-01', endDate: '2100-06-01', priceOverride: 1,
    }));
    expect(tooLong.status).toBe(400);

    const inverted = await postBulk(jsonReq({
      accommodationId: ACC_ID, startDate: '2099-08-31', endDate: '2099-08-01', priceOverride: 1,
    }));
    expect(inverted.status).toBe(400);
    expect(poolQueryMock).not.toHaveBeenCalled();
  });
});
