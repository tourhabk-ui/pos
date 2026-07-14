/**
 * POST /api/admin/places/bulk — массовое скрытие/удаление мест.
 * hide → UPDATE is_visible; delete → каскад в транзакции; валидация тела.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...a: unknown[]) => queryMock(...a) },
}));
vi.mock('@/lib/database', () => ({
  // transaction(cb) — прогоняем cb с client, чей query = queryMock.
  transaction: (cb: (c: { query: (...a: unknown[]) => unknown }) => Promise<void>) =>
    cb({ query: (...a: unknown[]) => queryMock(...a) }),
}));
vi.mock('@/lib/auth/middleware', () => ({
  requireAdmin: vi.fn().mockResolvedValue({ userId: 'admin', role: 'admin' }),
}));

import { POST } from '@/app/api/admin/places/bulk/route';

const UUID = '11111111-1111-1111-1111-111111111111';
const UUID2 = '22222222-2222-2222-2222-222222222222';

function req(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

describe('POST /api/admin/places/bulk', () => {
  beforeEach(() => queryMock.mockReset());

  it('action=hide → UPDATE is_visible=false, affected', async () => {
    queryMock.mockResolvedValue({ rowCount: 2 });
    const res = await POST(req({ ids: [UUID, UUID2], action: 'hide' }));
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, action: 'hide', affected: 2 });
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toContain('UPDATE places SET is_visible');
    expect(queryMock.mock.calls[0][1][0]).toBe(false); // hide → is_visible=false
  });

  it('action=unhide → is_visible=true', async () => {
    queryMock.mockResolvedValue({ rowCount: 1 });
    const res = await POST(req({ ids: [UUID], action: 'unhide' }));
    const body = await res.json();
    expect(body.action).toBe('unhide');
    expect(queryMock.mock.calls[0][1][0]).toBe(true);
  });

  it('action=delete → каскад в транзакции, affected из DELETE places', async () => {
    queryMock.mockImplementation((sql: string) => {
      const s = String(sql);
      if (s.includes('SELECT ark_id')) return Promise.resolve({ rows: [{ ark_id: 'a1' }] });
      if (s.includes('DELETE FROM places WHERE id = ANY')) return Promise.resolve({ rowCount: 1 });
      return Promise.resolve({ rowCount: 0 });
    });
    const res = await POST(req({ ids: [UUID], action: 'delete' }));
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, action: 'delete', affected: 1 });
    // каскад тронул зависимые таблицы
    const sqls = queryMock.mock.calls.map(c => String(c[0]));
    expect(sqls.some(s => s.includes('DELETE FROM ai_route_images'))).toBe(true);
    expect(sqls.some(s => s.includes('DELETE FROM route_waypoints'))).toBe(true);
    expect(sqls.some(s => s.includes('DELETE FROM places WHERE id = ANY'))).toBe(true);
  });

  it('пустой ids → 400, без запросов', async () => {
    const res = await POST(req({ ids: [], action: 'hide' }));
    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('неизвестный action → 400', async () => {
    const res = await POST(req({ ids: [UUID], action: 'nuke' }));
    expect(res.status).toBe(400);
  });

  it('невалидный UUID → 400', async () => {
    const res = await POST(req({ ids: ['not-a-uuid'], action: 'delete' }));
    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
