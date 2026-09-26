/**
 * Кабинет жилья: у проверки доступа три исхода (§4.0) — нашёлся / нет /
 * НЕ СМОГЛИ проверить.
 *
 * До 26.09 `getStayPartnerId` и `verifyAccommodationOwnership` глушили
 * отказ базы пустым catch: он превращался в 404 «Профиль владельца не
 * найден» / «Объект не найден», экран предлагал «Настроить кабинет» тому,
 * у кого кабинет настроен, а в логе не оставалось ни строки. Здесь же —
 * проверка номера в календаре и в /api/stay/rooms/[id], которая жила вне
 * try: не-uuid или отказ базы уходили необработанным 500.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const queryMock = vi.fn();
const poolQueryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));
const requireAuthMock = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
  requireRole: (...args: unknown[]) => requireAuthMock(...args),
}));
vi.mock('@/lib/auth/partner-profile', () => ({ ensurePartnerForRole: vi.fn() }));

import {
  getStayPartnerId, verifyAccommodationOwnership, requireAccommodationAccess, StayCheckUnavailableError,
} from '@/lib/auth/stay-helpers';
import { GET as ownerList } from '@/app/api/stay/accommodations/route';
import { GET as ownerStats } from '@/app/api/stay/stats/route';
import { PATCH as patchRoom } from '@/app/api/stay/rooms/[id]/route';
import { POST as setRate } from '@/app/api/stay/calendar/route';
import { POST as bulkRates } from '@/app/api/stay/calendar/bulk/route';

const ACC_ID = '33333333-3333-4333-8333-333333333333';
const ROOM_ID = '55555555-5555-4555-8555-555555555555';

function dbDown(): Error {
  return Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
}
function req(url: string, method = 'GET', body?: unknown): NextRequest {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }) as unknown as NextRequest;
}

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  queryMock.mockReset();
  poolQueryMock.mockReset();
  requireAuthMock.mockReset();
  requireAuthMock.mockResolvedValue({ userId: 'user-1', email: 'o@x.ru', role: 'stay' });
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

function loggedWith(name: string, sqlstate: string): boolean {
  return errSpy.mock.calls.some(args => String(args[0]).includes(name) && String(args[0]).includes(`sqlstate=${sqlstate}`));
}

describe('getStayPartnerId', () => {
  it('нашёлся / нет / не смогли — три разных исхода', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'p-1' }] });
    await expect(getStayPartnerId('u')).resolves.toBe('p-1');

    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(getStayPartnerId('u')).resolves.toBeNull();

    queryMock.mockRejectedValueOnce(dbDown());
    await expect(getStayPartnerId('u')).rejects.toBeInstanceOf(StayCheckUnavailableError);
    expect(loggedWith('getStayPartnerId', '57P01')).toBe(true);
  });

  it('порядок детерминирован: LIMIT 1 только после ORDER BY', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await getStayPartnerId('u');
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toMatch(/ORDER BY[\s\S]+LIMIT 1/);
  });
});

describe('verifyAccommodationOwnership / requireAccommodationAccess', () => {
  it('отказ базы — не «чужой объект»: бросает и пишет в лог', async () => {
    queryMock.mockRejectedValueOnce(dbDown());
    await expect(verifyAccommodationOwnership('u', ACC_ID)).rejects.toBeInstanceOf(StayCheckUnavailableError);
    expect(loggedWith('verifyAccommodationOwnership', '57P01')).toBe(true);
  });

  it('гвард: 503 при отказе базы, 404 при чужом, 400 при не-uuid (в базу не идёт)', async () => {
    queryMock.mockRejectedValueOnce(dbDown());
    const down = await requireAccommodationAccess(req('http://x/'), ACC_ID);
    expect((down as NextResponse).status).toBe(503);

    queryMock.mockResolvedValueOnce({ rows: [] });
    const foreign = await requireAccommodationAccess(req('http://x/'), ACC_ID);
    expect((foreign as NextResponse).status).toBe(404);

    queryMock.mockClear();
    const bad = await requireAccommodationAccess(req('http://x/'), 'not-a-uuid');
    expect((bad as NextResponse).status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('owner-роуты отвечают 503, а не «кабинет не настроен»', () => {
  it('GET /api/stay/accommodations', async () => {
    queryMock.mockRejectedValueOnce(dbDown());
    const res = await ownerList(req('http://localhost/api/stay/accommodations'));
    expect(res.status).toBe(503);
  });

  it('GET /api/stay/stats', async () => {
    queryMock.mockRejectedValueOnce(dbDown());
    const res = await ownerStats(req('http://localhost/api/stay/stats'));
    expect(res.status).toBe(503);
  });
});

describe('проверка номера: внутри try и с валидацией uuid', () => {
  it('/api/stay/rooms/[id]: не-uuid → 400 без базы; отказ базы → 503 с логом', async () => {
    const bad = await patchRoom(req('http://localhost/api/stay/rooms/xyz', 'PATCH', { name: 'A' }),
      { params: Promise.resolve({ id: 'xyz' }) });
    expect(bad.status).toBe(400);
    expect(poolQueryMock).not.toHaveBeenCalled();

    poolQueryMock.mockRejectedValueOnce(dbDown());
    const down = await patchRoom(req(`http://localhost/api/stay/rooms/${ROOM_ID}`, 'PATCH', { name: 'A' }),
      { params: Promise.resolve({ id: ROOM_ID }) });
    expect(down.status).toBe(503);
    expect(loggedWith('checkRoomAccess', '57P01')).toBe(true);
  });

  it('календарь: отказ базы на проверке номера — обработанный 500 с логом', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: ACC_ID }] }); // владение объектом
    poolQueryMock.mockRejectedValue(dbDown());
    const one = await setRate(req('http://localhost/api/stay/calendar', 'POST', {
      accommodationId: ACC_ID, date: '2099-01-01', roomId: ROOM_ID, isBlocked: true,
    }));
    expect(one.status).toBe(500);
    expect(loggedWith('POST /api/stay/calendar', '57P01')).toBe(true);

    const bulk = await bulkRates(req('http://localhost/api/stay/calendar/bulk', 'POST', {
      accommodationId: ACC_ID, roomId: ROOM_ID, startDate: '2099-01-01', endDate: '2099-01-03', isBlocked: true,
    }));
    expect(bulk.status).toBe(500);
    expect(loggedWith('POST /api/stay/calendar/bulk', '57P01')).toBe(true);
  });
});
