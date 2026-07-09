/**
 * tests/unit/admin-zod-validation.test.ts
 *
 * Zod-валидация admin-POST'ов (аудит 2026-07-09, п.1):
 * - finance POST (деньги): нечисловой/отрицательный amount → 400, без INSERT;
 * - octo-keys: webhook-поля валидируются схемой (раньше читались из сырого body);
 * - evo feedback: невалидный outcome → 400.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { requireAdminMock, queryMock, poolQueryMock } = vi.hoisted(() => ({
  requireAdminMock: vi.fn(),
  queryMock: vi.fn(),
  poolQueryMock: vi.fn(),
}));

vi.mock('@/lib/auth/middleware', () => ({
  requireAdmin: (...a: unknown[]) => requireAdminMock(...a),
}));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => queryMock(...a) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQueryMock(...a) } }));
vi.mock('@/lib/agents/evo/feedback-loop', () => ({
  submitFeedback: vi.fn().mockResolvedValue({ ok: true }),
  getEvoStats: vi.fn(),
}));
vi.mock('@/lib/agents/evo/rescue-agent', () => ({ runRescueScan: vi.fn() }));

import { POST as financePost } from '@/app/api/admin/finance/route';
import { POST as evoPost } from '@/app/api/admin/evo/route';
import { CreateApiKeySchema, UpdateApiKeySchema } from '@/lib/octo/schemas';

function req(url: string, body: unknown): NextRequest {
  return new Request(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  requireAdminMock.mockReset();
  queryMock.mockReset();
  poolQueryMock.mockReset();
  requireAdminMock.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
});

describe('POST /api/admin/finance — выплата (деньги)', () => {
  it('нечисловой amount → 400, INSERT не выполняется', async () => {
    const res = await financePost(req('http://l/api/admin/finance', {
      partnerId: 'p1', bookingId: 'b1', amount: 'сто рублей',
    }));
    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('отрицательный amount → 400', async () => {
    const res = await financePost(req('http://l/api/admin/finance', {
      partnerId: 'p1', bookingId: 'b1', amount: -500,
    }));
    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('валидная выплата → INSERT с параметрами', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: 'pay1', status: 'pending', created_at: 'now' }] });
    const res = await financePost(req('http://l/api/admin/finance', {
      partnerId: 'p1', bookingId: 42, amount: 15000,
    }));
    expect(res.status).toBe(201);
    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual(['p1', 42, 15000, 'RUB', 'Выплата оператору']);
  });
});

describe('octo-keys схемы — webhook-поля в схеме, не мимо неё', () => {
  it('CreateApiKeySchema принимает валидный webhookUrl и отклоняет не-URL', () => {
    expect(CreateApiKeySchema.safeParse({ name: 'k', webhookUrl: 'https://x.ru/hook' }).success).toBe(true);
    expect(CreateApiKeySchema.safeParse({ name: 'k', webhookUrl: 'not-a-url' }).success).toBe(false);
  });
  it('UpdateApiKeySchema: null очищает, отсутствие — не трогает', () => {
    const r = UpdateApiKeySchema.safeParse({ webhookUrl: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.webhookUrl).toBeNull();
    const r2 = UpdateApiKeySchema.safeParse({ name: 'renamed' });
    expect(r2.success).toBe(true);
    if (r2.success) expect(r2.data).not.toHaveProperty('webhookUrl');
  });
});

describe('POST /api/admin/evo — фидбек', () => {
  it('невалидный outcome → 400', async () => {
    const res = await evoPost(req('http://l/api/admin/evo', {
      evolution_id: 'e1', outcome: 'amazing',
    }));
    expect(res.status).toBe(400);
  });
  it('валидный фидбек → 200', async () => {
    const res = await evoPost(req('http://l/api/admin/evo', {
      evolution_id: 'e1', outcome: 'success', impact_score: 5,
    }));
    expect(res.status).toBe(200);
  });
});
