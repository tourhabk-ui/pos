/**
 * Связка производитель → потребитель для итога доставки заявки — вызовом:
 * GET /api/admin/operators отдаёт last_delivery из журнала, а при отказе
 * чтения поле не отдаётся (карточка пишет «не удалось прочитать»).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { queryMock, lastMock } = vi.hoisted(() => ({ queryMock: vi.fn(), lastMock: vi.fn() }));
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: vi.fn(async () => ({ userId: 'admin', role: 'admin' })) }));
vi.mock('@/lib/database', () => ({ query: queryMock }));
vi.mock('@/lib/leads/delivery-outcome', () => ({ lastPartnerDeliveries: lastMock }));

import { GET } from '@/app/api/admin/operators/route';

const OPS = [{ id: 'op-1', company_name: 'Местечко Камчатка' }, { id: 'op-2', company_name: 'Край Вулканов' }];

beforeEach(() => {
  queryMock.mockReset();
  lastMock.mockReset();
  queryMock.mockImplementation(async (sql: string) => (/COUNT\(\*\)/.test(sql) ? { rows: [{ total: '2' }] } : { rows: OPS }));
});

const req = () => new NextRequest('https://vedarai.ru/api/admin/operators?status=all');

describe('GET /api/admin/operators — last_delivery', () => {
  it('у оператора с записью — итог; без записи — null', async () => {
    lastMock.mockResolvedValue(new Map([['op-1', { lead_id: 'l1', at: '2026-10-15T02:46:12.000Z', state: 'delivered', channel: 'max', reason: null }]]));
    const res = await GET(req());
    const body = await res.json() as { data: Array<{ id: string; last_delivery?: unknown }> };
    expect(lastMock).toHaveBeenCalledWith(['op-1', 'op-2']);
    expect(body.data[0].last_delivery).toMatchObject({ state: 'delivered', channel: 'max' });
    expect(body.data[1].last_delivery).toBeNull();
  });

  it('чтение отказало — поля нет вовсе («не знаю» ≠ «записей нет»)', async () => {
    lastMock.mockResolvedValue(null);
    const res = await GET(req());
    const body = await res.json() as { data: Array<Record<string, unknown>> };
    expect('last_delivery' in body.data[0]).toBe(false);
  });
});

describe('POST /api/leads — производитель: итог личной доставки пишется в журнал заявки', () => {
  it('заявка с partner_slug: после личной доставки recordPartnerDelivery получает её исход', async () => {
    vi.resetModules();
    const recordMock = vi.fn(async () => true);
    const personalMock = vi.fn(async () => ({ state: 'delivered', channel: 'max' }));
    const poolQuery = vi.fn(async () => ({ rows: [{ id: 'op-mestechko', name: 'Местечко Камчатка' }] }));
    vi.doMock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));
    vi.doMock('@/lib/leads/delivery-outcome', () => ({ recordPartnerDelivery: recordMock, lastPartnerDeliveries: vi.fn() }));
    vi.doMock('@/lib/notifications/lead-notify', () => ({ notifyPartnerNewLeadPersonally: personalMock, notifyOperatorNewLead: vi.fn(async () => undefined) }));
    vi.doMock('@/lib/notifications/telegram', () => ({ telegramService: { sendMessage: vi.fn(async () => ({ success: true })) } }));
    vi.doMock('@/lib/rate-limit', () => ({ createRateLimiter: () => ({ check: () => true }), getTrustedClientIp: () => '203.0.113.5' }));
    vi.doMock('@/lib/services/operators/lead-processor.service', () => ({ leadProcessor: { process: vi.fn(async () => { throw new Error('не в этом тесте'); }) } }));
    vi.doMock('@/lib/leads/create', () => ({
      createLead: vi.fn(async () => 'lead-1'),
      createLeadDetailed: vi.fn(async () => ({ id: 'lead-1', created: true })),
    }));
    vi.doMock('@/lib/analytics/self-visit', () => ({ isSelfVisit: () => false }));
    vi.doMock('@/lib/mcp/handoff', () => ({ attachMcpAttribution: vi.fn(async () => null), MCP_ATTRIBUTION: { cookieName: 'mcp_h' } }));
    vi.doMock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: vi.fn(async () => ({ channel: 'max', delivered: true, reason: 'ok' })) }));
    vi.doMock('@/lib/config', () => ({ getPublicBaseUrl: () => 'https://vedarai.ru' }));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { POST } = await import('@/app/api/leads/route');
    const res = await POST(new NextRequest('https://vedarai.ru/api/leads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Тест', phone: '+79000000000', comment: 'проверка', partner_slug: 'mestechko', pd_consent: true }),
    }));
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(recordMock).toHaveBeenCalledTimes(1));
    expect(recordMock).toHaveBeenCalledWith('lead-1', 'op-mestechko', { state: 'delivered', channel: 'max' });
    expect(personalMock).toHaveBeenCalledTimes(1);
  });
});
