/**
 * GET /api/admin/finance читает живой контур tour_payments/operator_payouts,
 * а не legacy payments/payouts (которых в БД нет, роут отдавал 500).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { requireAdminMock, queryMock } = vi.hoisted(() => ({
  requireAdminMock: vi.fn(),
  queryMock: vi.fn(),
}));

vi.mock('@/lib/auth/middleware', () => ({
  requireAdmin: (...a: unknown[]) => requireAdminMock(...a),
}));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => queryMock(...a) }));
vi.mock('@/lib/eco/compensation', () => ({
  pendingCompensation: vi.fn().mockResolvedValue(null),
}));

import { GET as financeGet } from '@/app/api/admin/finance/route';

function req(url: string): NextRequest {
  return new Request(url) as unknown as NextRequest;
}

beforeEach(() => {
  requireAdminMock.mockReset();
  queryMock.mockReset();
  requireAdminMock.mockResolvedValue({ userId: 'admin-1', role: 'admin' });
});

describe('GET /api/admin/finance — живые таблицы', () => {
  it('overview: метрики из tour_payments, camelCase+числа для UI, без legacy-таблиц', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('unique_customers')) {
        return Promise.resolve({ rows: [{ total_transactions: '3', total_revenue: '30000.00', avg_transaction: '10000.00', unique_customers: '2' }] });
      }
      if (sql.includes('DATE(COALESCE')) {
        return Promise.resolve({ rows: [{ date: '2026-10-19', transactions: '3', revenue: '30000.00' }] });
      }
      if (sql.includes('booking_type')) {
        return Promise.resolve({ rows: [{ booking_type: 'tour', transactions: '3', revenue: '30000.00' }] });
      }
      if (sql.includes('operator_payouts')) {
        return Promise.resolve({ rows: [{ pending_count: '1', pending_amount: '9000.00' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await financeGet(req('http://l/api/admin/finance?period=30'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.metrics.totalRevenue).toBe(30000);
    expect(body.data.metrics.totalTransactions).toBe(3);
    expect(body.data.metrics.uniqueCustomers).toBe(2);
    expect(body.data.metrics.total_revenue).toBe('30000.00');
    expect(body.data.dailyRevenue).toEqual([{ date: '2026-10-19', transactions: 3, revenue: 30000 }]);
    expect(body.data.pendingPayouts.pending_count).toBe('1');

    const allSql = queryMock.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allSql).toContain('tour_payments');
    expect(allSql).toContain('operator_payouts');
    expect(allSql).not.toMatch(/FROM payments\b/);
    expect(allSql).not.toMatch(/FROM payouts\b/);
  });

  it('tab=payouts: список и статистика из operator_payouts', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('total_payouts')) {
        return Promise.resolve({ rows: [{ total_payouts: '2', completed_payouts: '1', pending_payouts: '1', total_paid: '9000.00', pending_amount: '9000.00' }] });
      }
      return Promise.resolve({ rows: [{ id: 'op1', partner_id: 'p1', amount: '9000.00' }] });
    });

    const res = await financeGet(req('http://l/api/admin/finance?tab=payouts'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.stats.completed_payouts).toBe('1');
    const allSql = queryMock.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allSql).toContain('operator_payouts');
    expect(allSql).toContain("status = 'PAID'");
  });
});
