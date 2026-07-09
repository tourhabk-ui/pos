/**
 * tests/unit/referral-attribution.test.ts
 *
 * Атрибуция брони агентской реф-ссылке (PR агентской реферальной программы):
 * - валидный ?ref → operator_bookings.referral_link_id = resolved id +
 *   post-commit аудит-событие + инкремент conversions;
 * - без ref → referral_link_id = null, реф-записей нет, бронь создаётся;
 * - GET реф-API считает конверсии/заработок из operator_bookings.referral_link_id.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const { clientQueryMock, poolQueryMock, requireAuthMock, requireAgentMock } = vi.hoisted(() => ({
  clientQueryMock: vi.fn(),
  poolQueryMock: vi.fn(),
  requireAuthMock: vi.fn(),
  requireAgentMock: vi.fn(),
}));

vi.mock('@/lib/db-pool', () => ({
  pool: {
    connect: vi.fn().mockResolvedValue({ query: (...a: unknown[]) => clientQueryMock(...a), release: vi.fn() }),
    query: (...a: unknown[]) => poolQueryMock(...a),
  },
}));

vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: (...a: unknown[]) => requireAuthMock(...a),
  requireAgent: (...a: unknown[]) => requireAgentMock(...a),
}));

import { POST as bookTour } from '@/app/api/bookings/tour/route';
import { GET as referralGet } from '@/app/api/hub/agent/referral/route';

const LINK_ID = '99999999-9999-9999-8999-999999999999';

function bookReq(body: unknown): NextRequest {
  return new Request('http://localhost/api/bookings/tour', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

// Маршрутизируем client.query по SQL для happy-path брони.
function routeBookingSql(withLink: boolean) {
  clientQueryMock.mockImplementation((sql: string) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve({ rows: [] });
    if (sql.includes('FROM users WHERE id')) return Promise.resolve({ rows: [{ id: 'u1', email: 'a@b.c', name: 'Гость' }] });
    if (sql.includes('FROM operator_tours')) return Promise.resolve({ rows: [{
      id: '5', title: 'Тур', base_price: '1000', currency: 'RUB', operator_id: 'op1',
      min_participants: 1, max_participants: 10, is_active: true,
      multi_day_count: null, duration_hours: null, duration_type: null,
      operator_name: 'Оп', commission_current: '15',
    }] });
    if (sql.includes('FROM tour_availability')) return Promise.resolve({ rows: [] });
    if (sql.includes('generate_series')) return Promise.resolve({ rows: [{ date: '2099-08-01', occupied: '0', available_slots: null, is_cancelled: null }] });
    if (sql.includes('FROM agent_referral_links')) return Promise.resolve({ rows: withLink ? [{ id: LINK_ID }] : [] });
    if (sql.includes('INSERT INTO operator_bookings')) return Promise.resolve({ rows: [{ id: '100' }] });
    if (sql.includes('INSERT INTO tour_payments')) return Promise.resolve({ rows: [{ id: 'pay1' }] });
    throw new Error('unexpected client SQL: ' + sql);
  });
}

beforeEach(() => {
  clientQueryMock.mockReset();
  poolQueryMock.mockReset();
  requireAuthMock.mockReset();
  requireAgentMock.mockReset();
  requireAuthMock.mockResolvedValue({ userId: 'u1' });
  requireAgentMock.mockResolvedValue({ userId: 'agent-1' });
  poolQueryMock.mockResolvedValue({ rows: [] });
});

describe('POST /api/bookings/tour — реферальная атрибуция', () => {
  it('валидный ref → referral_link_id в INSERT + аудит-событие + conversions++', async () => {
    routeBookingSql(true);
    const res = await bookTour(bookReq({ tourId: 5, bookingDate: '2099-08-01', participants: 2, ref: 'KH-AGT-ABC' }));
    expect(res.status).toBe(200);

    // резолв кода
    const resolve = clientQueryMock.mock.calls.find(([s]) => String(s).includes('FROM agent_referral_links'))!;
    expect(resolve[1]).toEqual(['KH-AGT-ABC']);
    // INSERT брони содержит referral_link_id последним параметром
    const insert = clientQueryMock.mock.calls.find(([s]) => String(s).includes('INSERT INTO operator_bookings'))!;
    expect(String(insert[0])).toContain('referral_link_id');
    expect(insert[1][insert[1].length - 1]).toBe(LINK_ID);
    // post-commit аудит через pool.query
    expect(poolQueryMock.mock.calls.some(([s]) => String(s).includes('INSERT INTO agent_referral_events'))).toBe(true);
    expect(poolQueryMock.mock.calls.some(([s]) => String(s).includes('SET conversions = conversions + 1'))).toBe(true);
  });

  it('без ref → referral_link_id = null, реф-записей нет, бронь ок', async () => {
    routeBookingSql(false);
    const res = await bookTour(bookReq({ tourId: 5, bookingDate: '2099-08-01', participants: 2 }));
    expect(res.status).toBe(200);
    const insert = clientQueryMock.mock.calls.find(([s]) => String(s).includes('INSERT INTO operator_bookings'))!;
    expect(insert[1][insert[1].length - 1]).toBeNull();
    // ссылку не резолвим, аудит не пишем
    expect(clientQueryMock.mock.calls.some(([s]) => String(s).includes('FROM agent_referral_links'))).toBe(false);
    expect(poolQueryMock.mock.calls.some(([s]) => String(s).includes('agent_referral_events'))).toBe(false);
  });
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
