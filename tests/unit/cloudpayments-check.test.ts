/**
 * CloudPayments: платится только подтверждённая оператором бронь (04.10,
 * владелец: «CloudPayments без серверной проверки — проверять статус, как у
 * QR СБП»).
 *
 * Два рубежа:
 *   1. Check до списания (/api/payments/check) — отказ, если бронь не
 *      подтверждена, уже оплачена, сумма другая или проверить не смогли.
 *   2. Pay после списания (оба приёмника) — оплата не переводит `new` в
 *      `confirmed`: подтверждает оператор, деньги записываются, человеку —
 *      тревога.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decideCloudPaymentsCheck, parseCheckBody } from '@/lib/payments/cloudpayments-check';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => queryMock(...a) }));

import { POST } from '@/app/api/payments/check/route';
import type { NextRequest } from 'next/server';

const SECRET = 'test-secret';
const sign = (body: string) => crypto.createHmac('sha256', SECRET).update(body).digest('base64');

function req(body: string, signature: string | null = sign(body)): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (signature) headers['X-Content-HMAC'] = signature;
  return new Request('http://localhost/api/payments/check', { method: 'POST', headers, body }) as unknown as NextRequest;
}

const row = (over: Record<string, unknown> = {}) => ({
  booking_status: 'confirmed', payment_status: null, paid_at: null, final_price: '28000.00', deleted: false, ...over,
});

beforeEach(() => {
  queryMock.mockReset();
  process.env.CLOUDPAYMENTS_API_SECRET = SECRET;
});

describe('решение Check', () => {
  it('подтверждённая бронь на свою сумму — 0', () => {
    expect(decideCloudPaymentsCheck(row(), 28000).code).toBe(0);
    expect(decideCloudPaymentsCheck(row({ booking_status: 'pending_payment' }), 28000.5).code).toBe(0);
  });
  it('новая заявка — 13: подтверждает оператор, не оплата', () => {
    expect(decideCloudPaymentsCheck(row({ booking_status: 'new' }), 28000)).toMatchObject({ code: 13 });
  });
  it('отменённая, оплаченная, удалённая, чужая сумма — отказ', () => {
    expect(decideCloudPaymentsCheck(row({ booking_status: 'cancelled' }), 28000).code).toBe(13);
    expect(decideCloudPaymentsCheck(row({ paid_at: new Date() }), 28000).code).toBe(13);
    expect(decideCloudPaymentsCheck(row({ deleted: true }), 28000).code).toBe(10);
    expect(decideCloudPaymentsCheck(null, 28000).code).toBe(10);
    expect(decideCloudPaymentsCheck(row(), 2800).code).toBe(12);
  });
  it('тело — форма или JSON', () => {
    expect(parseCheckBody('InvoiceId=42&Amount=28000.00')).toEqual({ invoiceId: '42', amount: 28000 });
    expect(parseCheckBody('{"InvoiceId":"42","Amount":28000}')).toEqual({ invoiceId: '42', amount: 28000 });
    expect(parseCheckBody('Amount=1')).toBeNull();
  });
});

describe('POST /api/payments/check', () => {
  it('подтверждённая бронь — code 0', async () => {
    queryMock.mockResolvedValue({ rows: [row()] });
    const res = await POST(req('InvoiceId=42&Amount=28000'));
    expect(await res.json()).toEqual({ code: 0 });
  });
  it('новая заявка — code 13', async () => {
    queryMock.mockResolvedValue({ rows: [row({ booking_status: 'new' })] });
    expect(await (await POST(req('InvoiceId=42&Amount=28000'))).json()).toEqual({ code: 13 });
  });
  it('без подписи или с чужой — отказ, база не спрашивается', async () => {
    expect(await (await POST(req('InvoiceId=42&Amount=28000', null))).json()).toEqual({ code: 13 });
    expect(await (await POST(req('InvoiceId=42&Amount=28000', 'AAAA'))).json()).toEqual({ code: 13 });
    expect(queryMock).not.toHaveBeenCalled();
  });
  it('база не ответила — отказ, а не пропуск', async () => {
    queryMock.mockRejectedValue(Object.assign(new Error('boom'), { code: '57P01' }));
    expect(await (await POST(req('InvoiceId=42&Amount=28000'))).json()).toEqual({ code: 13 });
  });
});

describe('Pay-приёмники не подтверждают бронь оплатой', () => {
  const code = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '').replace(/\/\/[^\n]*/g, '');
  for (const p of ['app/api/payments/webhook/route.ts', 'app/api/hub/operator/payments/webhook/route.ts']) {
    it(p, () => {
      const src = code(p);
      // Статус меняется только у брони, которую можно было платить.
      expect(src).toMatch(/booking_status IN \('confirmed', 'pending_payment'\)\s*THEN 'confirmed' ELSE booking_status END/);
      expect(src).not.toMatch(/booking_status\s*=\s*'confirmed'\s*,/);
      expect(src).not.toMatch(/THEN booking_status ELSE 'confirmed'/);
      // Неподтверждённая оплата — тревога человеку, не тишина.
      expect(src).toMatch(/canOfferPayment\(/);
      expect(src).toMatch(/tgSend\(/);
    });
  }
});
