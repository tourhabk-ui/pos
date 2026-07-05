/**
 * tests/unit/geocode-route.test.ts
 *
 * POST /api/admin/places/[id]/geocode — контракт issue #290:
 * координаты вне bbox Камчатки НЕ сохраняются (422 + out_of_bounds:true,
 * UPDATE не вызывается), внутри bbox — сохраняются как раньше.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));

// Админ авторизован — проверяем логику роута, не auth-мидлварь
vi.mock('@/lib/auth/middleware', () => ({
  requireAdmin: vi.fn().mockResolvedValue({ userId: 'admin-1', role: 'admin' }),
}));

import { POST } from '@/app/api/admin/places/[id]/geocode/route';

const PLACE_ID = '11111111-2222-3333-4444-555555555555';

function postReq(body: unknown): NextRequest {
  return new Request(`http://localhost/api/admin/places/${PLACE_ID}/geocode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const params = Promise.resolve({ id: PLACE_ID });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/admin/places/[id]/geocode — bbox-гейт (issue #290)', () => {
  it('координаты вне Камчатки → 422 + out_of_bounds, БД не трогается', async () => {
    const res = await POST(postReq({ lat: 55.75, lng: 37.62 }), { params }); // Москва
    const json = await res.json();

    expect(res.status).toBe(422);
    expect(json.ok).toBe(false);
    expect(json.out_of_bounds).toBe(true);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('координаты внутри Камчатки → сохраняются (UPDATE вызван)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ id: PLACE_ID, name: 'Вулкан Горелый' }] }) // SELECT missing coords
      .mockResolvedValueOnce({ rows: [] }); // UPDATE

    const res = await POST(postReq({ lat: 52.455, lng: 157.988 }), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.out_of_bounds).toBe(false);
    const updateCall = queryMock.mock.calls.find(([sql]) => String(sql).includes('UPDATE places'));
    expect(updateCall).toBeTruthy();
    expect(updateCall![1]).toEqual([52.455, 157.988, PLACE_ID]);
  });
});
