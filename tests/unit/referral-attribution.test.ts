/**
 * tests/unit/referral-attribution.test.ts
 *
 * Атрибуция брони агентской реф-ссылке. До 26.09 здесь проверялся
 * `POST /api/bookings/tour` — единственная дверь, писавшая referral_link_id.
 * Роут удалён (он списывал оплату до подтверждения оператором), а
 * атрибуция переехала в reserveBooking и проверяется сторожем
 * tests/unit/agent-pack-a.test.ts. Здесь остаётся чтение:
 * - GET реф-API считает конверсии/заработок из operator_bookings.referral_link_id.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const { poolQueryMock, requireAgentMock } = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  requireAgentMock: vi.fn(),
}));

vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...a: unknown[]) => poolQueryMock(...a) },
}));

vi.mock('@/lib/auth/middleware', () => ({
  requireAgent: (...a: unknown[]) => requireAgentMock(...a),
}));

import { GET as referralGet } from '@/app/api/hub/agent/referral/route';

const LINK_ID = '99999999-9999-9999-8999-999999999999';

beforeEach(() => {
  poolQueryMock.mockReset();
  requireAgentMock.mockReset();
  requireAgentMock.mockResolvedValue({ userId: 'agent-1' });
  poolQueryMock.mockResolvedValue({ rows: [] });
});

describe('GET /api/hub/agent/referral — earnings из источника истины', () => {
  it('считает конверсии/заработок из operator_bookings.referral_link_id', async () => {
    poolQueryMock.mockResolvedValue({ rows: [{
      id: LINK_ID, code: 'KH-AGT-ABC', tour_id: null, clicks: 3,
      commission_rate: '10', expires_at: null, is_active: true, created_at: '2026-07-01',
      tour_title: null, conversions: 2, earned_total: '200',
    }] });
    const req = new Request('http://localhost/api/hub/agent/referral') as unknown as NextRequest;
    const res = await referralGet(req);
    expect(res.status).toBe(200);
    const sql = String(poolQueryMock.mock.calls[0][0]);
    expect(sql).toContain('ob.referral_link_id = rl.id');   // источник истины
    expect(sql).not.toContain('agent_bookings');            // сломанный join убран
    const body = await res.json();
    expect(body.stats.totalConversions).toBe(2);
  });
});
