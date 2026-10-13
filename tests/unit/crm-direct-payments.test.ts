/**
 * CRM фаза 2в: оплата напрямую оператору — отдельно от оплаты через платформу.
 *
 * Решение владельца 11.10 («2в да»): `paid_at` и `payment_status` значат
 * «деньги прошли через платформу» и запускают книгу, комиссию и выплату (§7).
 * Деньги, полученные оператором наличными или переводом, через платформу не
 * шли: их записи живут в booking_direct_payments (миграция 1215) и ничего
 * из денежного пути платформы не трогают.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQueryMock(...a) } }));
const authMock = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({ requireOperator: (...a: unknown[]) => authMock(...a) }));
const ownsMock = vi.fn();
vi.mock('@/lib/bookings/operator-owns', () => ({ operatorOwnsBooking: (...a: unknown[]) => ownsMock(...a) }));
const eventMock = vi.fn(async () => undefined);
vi.mock('@/lib/crm/events', () => ({ recordSourceEventQuietly: (...a: unknown[]) => eventMock(...(a as [])) }));

import { directPaidTotal, directRemaining } from '@/lib/bookings/direct-payment-kinds';
import { GET, POST, PATCH } from '@/app/api/hub/operator/bookings/[id]/direct-payments/route';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ROUTE = 'app/api/hub/operator/bookings/[id]/direct-payments/route.ts';
const LIB = 'lib/bookings/direct-payments.ts';
const params = { params: Promise.resolve({ id: '501' }) };
const req = (method: string, body?: unknown) => new NextRequest('http://x/api/hub/operator/bookings/501/direct-payments', {
  method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
});

const ROW = {
  id: 'p-1', amount: 30000, method: 'cash', received_on: '2026-10-10', note: 'Предоплата',
  created_at: 'x', voided_at: null, void_reason: null,
};

const USER = '00000000-0000-4000-8000-0000000000a1';
const OWNER_ROW = { own_partner_id: 'op-1', member_partner_id: null, member_id: null, can_edit_prices: null, can_cancel_bookings: null, was_revoked: false };
const MANAGER_ROW = { own_partner_id: null, member_partner_id: 'op-1', member_id: 'm-1', can_edit_prices: true, can_cancel_bookings: true, was_revoked: false };

function db(access: Record<string, unknown> = OWNER_ROW) {
  poolQueryMock.mockImplementation(async (sql: string) => {
    // Кабинет вошедшего (operatorAccess, CRM 2г).
    if (/WITH own AS/.test(sql)) return { rows: [access] };
    if (/INSERT INTO booking_direct_payments/.test(sql)) return { rows: [ROW] };
    if (/UPDATE booking_direct_payments/.test(sql)) return { rows: [] };
    if (/FROM booking_direct_payments/.test(sql)) return { rows: [ROW] };
    if (/SELECT final_price FROM operator_bookings/.test(sql)) return { rows: [{ final_price: '100000.00' }] };
    return { rows: [] };
  });
}

beforeEach(() => {
  poolQueryMock.mockReset();
  ownsMock.mockReset();
  eventMock.mockClear();
  authMock.mockResolvedValue({ userId: USER, role: 'operator' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('расчёт', () => {
  it('получено — по действующим записям, аннулированные не считаются', () => {
    expect(directPaidTotal([{ amount: 30000, voided_at: null }, { amount: 70000, voided_at: '2026-10-11' }])).toBe(30000);
  });
  it('осталось: цена не записана — неизвестно (null), а не ноль; переплата — ноль', () => {
    expect(directRemaining(null, 30000)).toBeNull();
    expect(directRemaining(100000, 30000)).toBe(70000);
    expect(directRemaining(100000, 120000)).toBe(0);
  });
});

describe('денежный путь платформы не тронут', () => {
  for (const f of [ROUTE, LIB]) {
    it(`${f}: ни paid_at, ни payment_status, ни книги, ни комиссии`, () => {
      const src = code(f);
      expect(src).not.toMatch(/paid_at|payment_status|tour_payments|operator_commissions/);
      expect(src).not.toMatch(/holdTourPayment|recordCommissionFromBooking/);
    });
  }
});

describe('роут', () => {
  it('чужая бронь — 404, записи нет; не смогли проверить — 503', async () => {
    db();
    ownsMock.mockResolvedValue('denied');
    expect((await POST(req('POST', { amount: 100, method: 'cash', received_on: '2026-10-10' }), params)).status).toBe(404);
    ownsMock.mockResolvedValue('unknown');
    expect((await GET(req('GET'), params)).status).toBe(503);
    expect(poolQueryMock.mock.calls.some((c) => /INSERT/.test(String(c[0])))).toBe(false);
  });

  it('дата получения в будущем — 400', async () => {
    db();
    ownsMock.mockResolvedValue('ok');
    const res = await POST(req('POST', { amount: 100, method: 'cash', received_on: '2999-01-01' }), params);
    expect(res.status).toBe(400);
  });

  it('запись: сумма, способ, «осталось»; в ленту — без примечания', async () => {
    db();
    ownsMock.mockResolvedValue('ok');
    const res = await POST(req('POST', { amount: 30000, method: 'cash', received_on: '2026-10-10', note: 'Анна, +7900' }), params);
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { paid: number; remaining: number; final_price: number } };
    expect(body.data).toMatchObject({ paid: 30000, final_price: 100000, remaining: 70000 });
    expect(eventMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'change', sourceKind: 'operator_booking', sourceId: '501',
      payload: { amount: 30000, method: 'cash', received_on: '2026-10-10' },
    }));
    expect(JSON.stringify(eventMock.mock.calls)).not.toMatch(/\+7900|Анна/);
  });

  it('менеджер команды — 403 «деньги ведёт владелец», в базу ничего не пишется (CRM 2г)', async () => {
    db(MANAGER_ROW);
    ownsMock.mockResolvedValue('ok');
    for (const res of [
      await GET(req('GET'), params),
      await POST(req('POST', { amount: 100, method: 'cash', received_on: '2026-10-10' }), params),
      await PATCH(req('PATCH', { payment_id: '6f1c2c1e-1111-4222-8333-444455556666', reason: 'ошибка в сумме' }), params),
    ]) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/владелец кабинета/);
    }
    expect(poolQueryMock.mock.calls.some((c) => /booking_direct_payments/.test(String(c[0])))).toBe(false);
  });

  it('аннулирование без записи или повторное — 404', async () => {
    db();
    ownsMock.mockResolvedValue('ok');
    const res = await PATCH(req('PATCH', { payment_id: '6f1c2c1e-1111-4222-8333-444455556666', reason: 'ошибка в сумме' }), params);
    expect(res.status).toBe(404);
  });
});

describe('экраны и сводка', () => {
  it('карточка брони показывает блок; браузер не тянет пул базы', () => {
    expect(read('app/hub/operator/bookings/[id]/_BookingDetailClient.tsx')).toMatch(/<DirectPayments bookingId=/);
    const block = read('app/hub/operator/bookings/[id]/_DirectPayments.tsx');
    expect(block).toMatch(/from '@\/lib\/bookings\/direct-payment-kinds'/);
    expect(block).not.toMatch(/lib\/bookings\/direct-payments'/);
    expect(read('lib/bookings/direct-payment-kinds.ts')).not.toMatch(/db-pool/);
  });

  it('сводка: «напрямую» отдельной строкой, отказ — «не прочитано»', () => {
    const route = code('app/api/hub/operator/earnings/route.ts');
    expect(route).toMatch(/FROM booking_direct_payments dp[\s\S]*dp\.voided_at IS NULL/);
    expect(route).toMatch(/directReceived,/);
    const card = read('components/operator/OperatorEarningsCard.tsx');
    expect(card).toMatch(/Получено напрямую за \{periodDays\} дней/);
    expect(card).toMatch(/summary\.directReceived === null[\s\S]*не прочитано/);
  });

  it('миграция 1215: сумма > 0, способ из списка, аннулирование с причиной', () => {
    const sql = read('migrations/1215_booking_direct_payments.sql');
    expect(sql).toMatch(/CHECK \(amount > 0\)/);
    expect(sql).toMatch(/method IN \('cash', 'transfer', 'card', 'other'\)/);
    expect(sql).toMatch(/booking_direct_payments_void_complete/);
  });
});
