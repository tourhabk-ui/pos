/**
 * tests/unit/stay-photos.test.ts
 *
 * Фото объектов жилья (owner):
 * - POST привязывает URL к объекту через assets (sha256-дедуп) +
 *   accommodation_assets, повторный URL не плодит ассеты;
 * - относительный dev-путь /uploads/... принимается;
 * - DELETE отвязывает (assets не удаляется), чужая связка → 404;
 * - чужой объект → 404 без записи.
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

import { GET as getPhotos, POST as postPhoto } from '@/app/api/stay/accommodations/[id]/photos/route';
import { DELETE as deletePhoto } from '@/app/api/stay/accommodations/[id]/photos/[assetId]/route';

const ACC_ID = '33333333-3333-4333-8333-333333333333';
const ASSET_ID = '77777777-7777-4777-8777-777777777777';

function jsonReq(url: string, method: string, body?: unknown): NextRequest {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }) as unknown as NextRequest;
}

beforeEach(() => {
  poolQueryMock.mockReset();
  requireAuthMock.mockReset();
  verifyOwnershipMock.mockReset();
  requireAuthMock.mockResolvedValue({ userId: 'user-1', role: 'stay' });
  verifyOwnershipMock.mockResolvedValue(true);
});

describe('POST /api/stay/accommodations/[id]/photos', () => {
  it('новый URL: INSERT в assets + связка', async () => {
    poolQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id FROM assets')) return Promise.resolve({ rows: [] });
      if (sql.includes('INSERT INTO assets')) return Promise.resolve({ rows: [{ id: ASSET_ID }] });
      if (sql.includes('INSERT INTO accommodation_assets')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await postPhoto(
      jsonReq(`http://localhost/api/stay/accommodations/${ACC_ID}/photos`, 'POST', {
        url: 'https://s3.example.com/uploads/x.jpg',
      }),
      { params: Promise.resolve({ id: ACC_ID }) }
    );
    expect(res.status).toBe(201);

    const linkSql = String(poolQueryMock.mock.calls.find(([sql]) => String(sql).includes('accommodation_assets'))![0]);
    expect(linkSql).toContain('ON CONFLICT DO NOTHING');
  });

  it('существующий sha256 → ассет переиспользуется, INSERT assets не выполняется', async () => {
    poolQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id FROM assets')) return Promise.resolve({ rows: [{ id: ASSET_ID }] });
      if (sql.includes('INSERT INTO accommodation_assets')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await postPhoto(
      jsonReq(`http://localhost/api/stay/accommodations/${ACC_ID}/photos`, 'POST', {
        url: 'https://s3.example.com/uploads/x.jpg',
      }),
      { params: Promise.resolve({ id: ACC_ID }) }
    );
    expect(res.status).toBe(201);
    expect(poolQueryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO assets'))).toBe(false);
  });

  it('dev-путь /uploads/... принимается, произвольная строка — нет', async () => {
    poolQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id FROM assets')) return Promise.resolve({ rows: [{ id: ASSET_ID }] });
      return Promise.resolve({ rows: [] });
    });

    const ok = await postPhoto(
      jsonReq(`http://localhost/api/stay/accommodations/${ACC_ID}/photos`, 'POST', { url: '/uploads/123-abc.jpg' }),
      { params: Promise.resolve({ id: ACC_ID }) }
    );
    expect(ok.status).toBe(201);

    const bad = await postPhoto(
      jsonReq(`http://localhost/api/stay/accommodations/${ACC_ID}/photos`, 'POST', { url: 'not-a-url' }),
      { params: Promise.resolve({ id: ACC_ID }) }
    );
    expect(bad.status).toBe(400);
  });

  it('чужой объект → 404, ничего не пишется', async () => {
    verifyOwnershipMock.mockResolvedValue(false);
    const res = await postPhoto(
      jsonReq(`http://localhost/api/stay/accommodations/${ACC_ID}/photos`, 'POST', { url: 'https://x.ru/a.jpg' }),
      { params: Promise.resolve({ id: ACC_ID }) }
    );
    expect(res.status).toBe(404);
    expect(poolQueryMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/stay/accommodations/[id]/photos/[assetId]', () => {
  it('отвязывает связку, assets не трогает', async () => {
    poolQueryMock.mockResolvedValue({ rowCount: 1, rows: [] });

    const res = await deletePhoto(
      jsonReq(`http://localhost/api/stay/accommodations/${ACC_ID}/photos/${ASSET_ID}`, 'DELETE'),
      { params: Promise.resolve({ id: ACC_ID, assetId: ASSET_ID }) }
    );
    expect(res.status).toBe(200);

    const [sql] = poolQueryMock.mock.calls[0];
    expect(String(sql)).toContain('DELETE FROM accommodation_assets');
    expect(String(sql)).not.toContain('DELETE FROM assets');
  });

  it('несуществующая связка → 404', async () => {
    poolQueryMock.mockResolvedValue({ rowCount: 0, rows: [] });
    const res = await deletePhoto(
      jsonReq(`http://localhost/api/stay/accommodations/${ACC_ID}/photos/${ASSET_ID}`, 'DELETE'),
      { params: Promise.resolve({ id: ACC_ID, assetId: ASSET_ID }) }
    );
    expect(res.status).toBe(404);
  });

  it('GET отдаёт фото объекта', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{ id: ASSET_ID, url: '/uploads/a.jpg', alt: '', created_at: null }] });
    const res = await getPhotos(
      jsonReq(`http://localhost/api/stay/accommodations/${ACC_ID}/photos`, 'GET'),
      { params: Promise.resolve({ id: ACC_ID }) }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.photos).toHaveLength(1);
  });
});
