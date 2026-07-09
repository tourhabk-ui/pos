/**
 * tests/unit/kvert-admin.test.ts
 *
 * Админ-эндпоинт KVERT ACC: POST (синк) + PATCH (ручная установка цвета).
 * Проверяем гейт requireAdmin, Zod-валидацию и вызов сервисных функций.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { requireAdminMock, syncMock, setMock } = vi.hoisted(() => ({
  requireAdminMock: vi.fn(),
  syncMock: vi.fn(),
  setMock: vi.fn(),
}));

vi.mock('@/lib/auth/middleware', () => ({
  requireAdmin: (...a: unknown[]) => requireAdminMock(...a),
}));

vi.mock('@/lib/agents/kvert-sync', () => ({
  syncKvertAcc: (...a: unknown[]) => syncMock(...a),
  setVolcanoAcc: (...a: unknown[]) => setMock(...a),
}));

import { POST, PATCH } from '@/app/api/admin/safety/kvert-sync/route';

function req(body?: unknown): NextRequest {
  return new Request('http://localhost/api/admin/safety/kvert-sync', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  requireAdminMock.mockReset();
  syncMock.mockReset();
  setMock.mockReset();
  requireAdminMock.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
});

describe('POST /api/admin/safety/kvert-sync', () => {
  it('не-админ → 401/403 (проброс NextResponse)', async () => {
    requireAdminMock.mockResolvedValue(NextResponse.json({ error: 'no' }, { status: 403 }));
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(syncMock).not.toHaveBeenCalled();
  });

  it('админ → запускает синк', async () => {
    syncMock.mockResolvedValue({ fetched: 2, upserted: 2, matched: 1, unmatched: ['Ebeko'] });
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.upserted).toBe(2);
  });

  it('KVERT недоступен → 502', async () => {
    syncMock.mockRejectedValue(new Error('KVERT недоступен: HTTP 403'));
    const res = await POST(req());
    expect(res.status).toBe(502);
  });
});

describe('PATCH /api/admin/safety/kvert-sync', () => {
  it('валидный цвет → setVolcanoAcc', async () => {
    setMock.mockResolvedValue({ ok: true, matched: true });
    const res = await PATCH(req({ volcanoName: 'Ключевской', color: 'red' }));
    expect(res.status).toBe(200);
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ volcanoName: 'Ключевской', color: 'red' }));
  });

  it('невалидный цвет → 400, без вызова сервиса', async () => {
    const res = await PATCH(req({ volcanoName: 'Ключевской', color: 'purple' }));
    expect(res.status).toBe(400);
    expect(setMock).not.toHaveBeenCalled();
  });

  it('нет имени → 400', async () => {
    const res = await PATCH(req({ color: 'green' }));
    expect(res.status).toBe(400);
  });
});
