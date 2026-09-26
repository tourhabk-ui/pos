/**
 * Кабинет агента, пакет B (26.09) — роуты денег агента на моках.
 *
 * Что держится: заявка требует одобрения и одна открытая на агента; в неё
 * идут только продажи «к выплате»; ставки нет — заявки нет; отметка
 * администратора требует основания и не проходит, если бронь отменили после
 * заявки; агент видит только свои деньги; обзор не падает на клиенте с
 * jsonb-тегами (он их больше не читает). SQL как таковой исполняется на
 * настоящем PostgreSQL в tests/integration/agent-money.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

type Q = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>;
let clientQuery: Q = async () => ({ rows: [] });
const poolQuery = vi.fn<Q>();

vi.mock('@/lib/database', () => ({
  transaction: async <T,>(cb: (c: { query: Q }) => Promise<T>) => cb({ query: (s, p) => clientQuery(s, p) }),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (s: string, p?: unknown[]) => poolQuery(s, p) } }));

const approved = vi.fn();
vi.mock('@/lib/auth/agent-approval', () => ({ requireApprovedAgent: (...a: unknown[]) => approved(...a) }));
const agentAuth = vi.fn();
const adminAuth = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  requireAgent: (...a: unknown[]) => agentAuth(...a),
  requireAdmin: (...a: unknown[]) => adminAuth(...a),
}));

import { AGENT_MONEY_SQL, type SaleRow } from '@/lib/payments/agent-commission';
import { POST as requestPayout } from '@/app/api/agent/commissions/request-payout/route';
import { GET as commissionsGet } from '@/app/api/agent/commissions/route';
import { GET as payoutsGet } from '@/app/api/agent/commissions/payouts/route';
import { POST as adminPayoutsPost } from '@/app/api/admin/agent-commission/payouts/route';
import { POST as adminRatePost } from '@/app/api/admin/agent-commission/rate/route';
import { GET as dashboardGet } from '@/app/api/agent/dashboard/route';
import { GET as statsGet } from '@/app/api/agent/stats/route';

const AGENT = { userId: '11111111-1111-4111-8111-111111111111', role: 'agent', email: 'a@x' };
const ADMIN = { userId: '22222222-2222-4222-8222-222222222222', role: 'admin', email: 'b@x' };
const PAYOUT_ID = '33333333-3333-4333-8333-333333333333';

function req(url: string, body?: unknown): NextRequest {
  const r = new Request(url, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }) as unknown as NextRequest;
  (r as unknown as { nextUrl: URL }).nextUrl = new URL(url);
  return r;
}

function sale(over: Partial<SaleRow> = {}): SaleRow {
  return {
    booking_id: '101', booking_date: '2026-08-01', tour_title: 'Тур', final_price: '10000.00',
    booking_status: 'confirmed', referral_link_id: null, voided: false, paid: true,
    release_after: '2026-08-03 12:00:00', released: true,
    payout_id: null, payout_status: null, item_rate: null, item_amount: null, ...over,
  };
}

/** Клиент транзакции заявки: профиль, открытая заявка, продажи — по тексту SQL. */
function payoutClient(opts: { rate: string | null; open?: boolean; sales: SaleRow[]; failInsert?: string }) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  clientQuery = async (sql, params) => {
    calls.push({ sql, params });
    if (sql === AGENT_MONEY_SQL.lockAgentProfile) {
      return { rows: [{ partner_id: 'p', profile_status: 'approved', rate: opts.rate, rate_set_at: null }] };
    }
    if (sql === AGENT_MONEY_SQL.sales) return { rows: opts.sales };
    if (sql === AGENT_MONEY_SQL.openPayout) return { rows: opts.open ? [{ id: 'x' }] : [] };
    if (sql === AGENT_MONEY_SQL.insertPayout) return { rows: [{ id: PAYOUT_ID, created_at: '2026-09-26' }] };
    if (sql === AGENT_MONEY_SQL.insertItems) {
      if (opts.failInsert) throw Object.assign(new Error('dup'), { code: opts.failInsert });
      return { rows: [] };
    }
    throw new Error(`неожиданный SQL: ${sql.slice(0, 60)}`);
  };
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  approved.mockResolvedValue(AGENT);
  agentAuth.mockResolvedValue(AGENT);
  adminAuth.mockResolvedValue(ADMIN);
  poolQuery.mockResolvedValue({ rows: [] });
});

describe('POST /api/agent/commissions/request-payout', () => {
  it('неодобренный агент получает отказ гейта, база не спрашивается', async () => {
    approved.mockResolvedValue(NextResponse.json({ success: false, error: 'Кабинет агента откроется после одобрения администратором' }, { status: 403 }));
    const calls = payoutClient({ rate: '10', sales: [sale()] });
    const res = await requestPayout(req('http://x/api/agent/commissions/request-payout', {}));
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('ставки нет — 409, заявка не создаётся', async () => {
    const calls = payoutClient({ rate: null, sales: [sale()] });
    const res = await requestPayout(req('http://x/api/agent/commissions/request-payout', {}));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/Ставка вознаграждения не назначена/);
    expect(calls.some((c) => c.sql === AGENT_MONEY_SQL.insertPayout)).toBe(false);
  });

  it('открытая заявка уже есть — 409, вторая не создаётся', async () => {
    const calls = payoutClient({ rate: '10', open: true, sales: [sale()] });
    const res = await requestPayout(req('http://x/api/agent/commissions/request-payout', {}));
    expect(res.status).toBe(409);
    expect(calls.some((c) => c.sql === AGENT_MONEY_SQL.insertPayout)).toBe(false);
  });

  it('в заявку идут только продажи к выплате; ставка и сумма — снимком', async () => {
    const calls = payoutClient({
      rate: '10',
      sales: [
        sale({ booking_id: '1' }),
        sale({ booking_id: '2', voided: true }),
        sale({ booking_id: '3', paid: false }),
        sale({ booking_id: '4', released: false }),
        sale({ booking_id: '5', payout_id: 'old', payout_status: 'paid', item_rate: '5', item_amount: '500' }),
        sale({ booking_id: '6', final_price: '2500.50' }),
      ],
    });
    const res = await requestPayout(req('http://x/api/agent/commissions/request-payout', { paymentMethod: 'sbp' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ payoutId: PAYOUT_ID, totalAmount: 1250.05, bookingCount: 2 });
    const payout = calls.find((c) => c.sql === AGENT_MONEY_SQL.insertPayout);
    expect(payout?.params).toEqual([AGENT.userId, 1250.05, 'sbp', null]);
    const items = calls.find((c) => c.sql === AGENT_MONEY_SQL.insertItems);
    expect(items?.params).toEqual([PAYOUT_ID, AGENT.userId, ['1', '6'], [10000, 2500.5], [10, 10], [1000, 250.05]]);
    // Замок на записи агента — первым запросом.
    expect(calls[0].sql).toBe(AGENT_MONEY_SQL.lockAgentProfile);
  });

  it('нечего выплачивать — 400', async () => {
    payoutClient({ rate: '10', sales: [sale({ released: false })] });
    const res = await requestPayout(req('http://x/api/agent/commissions/request-payout', {}));
    expect(res.status).toBe(400);
  });

  it('параллельная заявка упёрлась в уникальный индекс — 409, а не 500', async () => {
    payoutClient({ rate: '10', sales: [sale()], failInsert: '23505' });
    const res = await requestPayout(req('http://x/api/agent/commissions/request-payout', {}));
    expect(res.status).toBe(409);
  });

  it('прочий отказ базы — 503 и лог с SQLSTATE', async () => {
    payoutClient({ rate: '10', sales: [sale()], failInsert: '22P02' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await requestPayout(req('http://x/api/agent/commissions/request-payout', {}));
    expect(res.status).toBe(503);
    expect(spy.mock.calls.some((c) => c.join(' ').includes('22P02'))).toBe(true);
    spy.mockRestore();
  });

  it('неизвестный способ выплаты отклоняется Zod', async () => {
    payoutClient({ rate: '10', sales: [sale()] });
    const res = await requestPayout(req('http://x/api/agent/commissions/request-payout', { paymentMethod: 'cash-in-envelope' }));
    expect(res.status).toBe(400);
  });
});

describe('агент видит только свои деньги', () => {
  it('GET /api/agent/commissions спрашивает базу id из JWT и не берёт агента из запроса', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    const res = await commissionsGet(req(`http://x/api/agent/commissions?agentId=${ADMIN.userId}`));
    expect(res.status).toBe(200);
    for (const [, params] of poolQuery.mock.calls) {
      expect((params as unknown[])[0]).toBe(AGENT.userId);
    }
    const body = await res.json();
    expect(body.data.rate).toBeNull();
    expect(body.data.summary.payable).toBeNull();
  });

  it('GET /api/agent/commissions/payouts — статус только из белого списка', async () => {
    const bad = await payoutsGet(req('http://x/api/agent/commissions/payouts?status=processing'));
    expect(bad.status).toBe(400);
    const ok = await payoutsGet(req('http://x/api/agent/commissions/payouts?status=paid'));
    expect(ok.status).toBe(200);
    expect(poolQuery.mock.calls[0][1]).toEqual([AGENT.userId, 100]);
  });

  it('отказ базы — 503, а не пустые деньги', async () => {
    poolQuery.mockRejectedValue(Object.assign(new Error('x'), { code: '42P01' }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await commissionsGet(req('http://x/api/agent/commissions'));
    expect(res.status).toBe(503);
    spy.mockRestore();
  });
});

describe('POST /api/admin/agent-commission/payouts — отметка администратора', () => {
  function adminClient(opts: { status?: string; blockers?: Array<{ booking_id: string }> }) {
    const calls: string[] = [];
    clientQuery = async (sql) => {
      calls.push(sql);
      if (sql === AGENT_MONEY_SQL.lockPayout) {
        return { rows: opts.status ? [{ id: PAYOUT_ID, agent_user_id: AGENT.userId, status: opts.status }] : [] };
      }
      if (sql === AGENT_MONEY_SQL.payoutBlockers) return { rows: opts.blockers ?? [] };
      return { rows: [{ id: PAYOUT_ID }] };
    };
    return calls;
  }

  it('основание короче 8 символов — 422, в базу не ходим', async () => {
    const calls = adminClient({ status: 'pending' });
    const res = await adminPayoutsPost(req('http://x', { payoutId: PAYOUT_ID, action: 'mark_paid', reason: 'ок' }));
    expect(res.status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it('бронь отменена после заявки — 409 со списком, выплата не отмечается', async () => {
    const calls = adminClient({ status: 'pending', blockers: [{ booking_id: '7' }] });
    const res = await adminPayoutsPost(req('http://x', { payoutId: PAYOUT_ID, action: 'mark_paid', reason: 'перевод №4412 от 26.09' }));
    expect(res.status).toBe(409);
    expect((await res.json()).bookings).toEqual(['7']);
    expect(calls).not.toContain(AGENT_MONEY_SQL.markPaid);
  });

  it('всё годно — отмечено, с автором из JWT и основанием', async () => {
    const seen: Array<{ sql: string; params?: unknown[] }> = [];
    adminClient({ status: 'pending' });
    const inner = clientQuery;
    clientQuery = async (sql, params) => { seen.push({ sql, params }); return inner(sql, params); };
    const res = await adminPayoutsPost(req('http://x', { payoutId: PAYOUT_ID, action: 'mark_paid', reason: 'перевод №4412 от 26.09' }));
    expect(res.status).toBe(200);
    const mark = seen.find((c) => c.sql === AGENT_MONEY_SQL.markPaid);
    expect(mark?.params).toEqual([PAYOUT_ID, ADMIN.userId, 'перевод №4412 от 26.09']);
  });

  it('отказ освобождает позиции — их можно запросить заново', async () => {
    const calls = adminClient({ status: 'pending' });
    const res = await adminPayoutsPost(req('http://x', { payoutId: PAYOUT_ID, action: 'reject', reason: 'реквизиты не совпадают' }));
    expect(res.status).toBe(200);
    expect(calls).toContain(AGENT_MONEY_SQL.reject);
    expect(calls).toContain(AGENT_MONEY_SQL.releaseItems);
    expect(calls).not.toContain(AGENT_MONEY_SQL.markPaid);
  });

  it('уже обработанную заявку второй раз не отметить', async () => {
    const calls = adminClient({ status: 'paid' });
    const res = await adminPayoutsPost(req('http://x', { payoutId: PAYOUT_ID, action: 'mark_paid', reason: 'перевод №4412 от 26.09' }));
    expect(res.status).toBe(409);
    expect(calls).not.toContain(AGENT_MONEY_SQL.markPaid);
  });

  it('не администратор — отказ гейта', async () => {
    adminAuth.mockResolvedValue(NextResponse.json({ error: 'нет' }, { status: 403 }));
    const res = await adminPayoutsPost(req('http://x', { payoutId: PAYOUT_ID, action: 'mark_paid', reason: 'перевод №4412 от 26.09' }));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/admin/agent-commission/rate', () => {
  it('ставка без основания не назначается', async () => {
    const res = await adminRatePost(req('http://x', { partnerId: PAYOUT_ID, rate: 10, reason: 'ок' }));
    expect(res.status).toBe(400);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('больше 30% не принимается', async () => {
    const res = await adminRatePost(req('http://x', { partnerId: PAYOUT_ID, rate: 45, reason: 'договор от 26.09' }));
    expect(res.status).toBe(400);
  });

  it('назначение пишет автора из JWT; агента нет — 404', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ partner_id: PAYOUT_ID, rate: '12.00' }] });
    const ok = await adminRatePost(req('http://x', { partnerId: PAYOUT_ID, rate: 12, reason: 'договор от 26.09' }));
    expect(ok.status).toBe(200);
    expect(poolQuery.mock.calls[0][1]).toEqual([PAYOUT_ID, 12, ADMIN.userId, 'договор от 26.09']);
    poolQuery.mockResolvedValueOnce({ rows: [] });
    const missing = await adminRatePost(req('http://x', { partnerId: PAYOUT_ID, rate: null, reason: 'снять ставку по письму' }));
    expect(missing.status).toBe(404);
  });
});

describe('обзор и статистика агента', () => {
  it('обзор не падает и не знает про jsonb-теги клиентов; ставки нет — null', async () => {
    poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('agent_clients')) {
        return { rows: [{ total_clients: 2, active_clients: 1, total_bookings: 3, cancelled_bookings: 1,
          completed_bookings: 0, unpaid_bookings: 1, paid_revenue: '0', paid_bookings: 0 }] };
      }
      return { rows: [] };
    });
    const res = await dashboardGet(req('http://x/api/agent/dashboard?period=7'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.metrics.averageBookingValue).toBeNull();
    expect(body.data.commission.rate).toBeNull();
    expect(body.data.commission.payable).toBeNull();
  });

  it('обзор: неизвестный период — 400', async () => {
    const res = await dashboardGet(req('http://x/api/agent/dashboard?period=1000'));
    expect(res.status).toBe(400);
  });

  it('статистика: отказ базы — 503 с логом, а не «0K ₽»', async () => {
    poolQuery.mockRejectedValue(Object.assign(new Error('x'), { code: '53300' }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await statsGet(req('http://x/api/agent/stats'));
    expect(res.status).toBe(503);
    expect(spy.mock.calls.some((c) => c.join(' ').includes('53300'))).toBe(true);
    spy.mockRestore();
  });

  it('статистика: клиентов нет — удержание null, а не 0%', async () => {
    poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('per_client')) return { rows: [{ clients: 0, repeat_clients: 0 }] };
      return { rows: [] };
    });
    const res = await statsGet(req('http://x/api/agent/stats'));
    const body = await res.json();
    expect(body.data.retention).toBeNull();
  });
});
