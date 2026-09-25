/**
 * Денежный путь «заявка → подтверждение оператора → оплата» (25.09, решение
 * владельца «чини платежи»).
 *
 * Найдено:
 *   1. СБП QR принимал только `new`/`pending_payment`, а страница брони
 *      предлагает оплату только `confirmed`/`pending_payment`: после
 *      подтверждения оператором СБП отвечал 404, а Кузьмич выдавал QR на
 *      неподтверждённую заявку. Выдача QR ставила `pending_payment` —
 *      подтверждённая бронь теряла места в счёте занятости и через сутки
 *      отменялась кроном. Опрос считал «оплачено» любую confirmed-бронь.
 *   2. `tour_payments` не писали СБП Точки и оплата брони из кабинета через
 *      CloudPayments; третий приёмник писал с ON CONFLICT без предиката
 *      частичного индекса — 42P10 на каждой оплате.
 *   3. `/api/payments/webhook` ставил выплату оператору через 36 часов после
 *      ОПЛАТЫ, а не после тура; шёл первым в таблицу `payments`, которой на
 *      проде нет, и не сверял сумму.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
/** Код без комментариев: история в комментариях законно называет старое. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const { queryMock, createQrMock } = vi.hoisted(() => ({ queryMock: vi.fn(), createQrMock: vi.fn() }));

vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));
vi.mock('@/lib/payments/tochka', () => ({
  createSBPQR: (...a: unknown[]) => createQrMock(...a),
  isTochkaConfigured: () => true,
  tochkaMissingEnv: () => [],
}));

import { POST, GET } from '@/app/api/payments/tochka/qr/route';
import type { NextRequest } from 'next/server';

function post(body: unknown): NextRequest {
  return new Request('http://localhost/api/payments/tochka/qr', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function booking(over: Record<string, unknown>) {
  return { final_price: 5000, title: 'Тур', tochka_qr_id: null, booking_status: 'confirmed', paid_at: null, ...over };
}

beforeEach(() => {
  queryMock.mockReset();
  createQrMock.mockReset();
  createQrMock.mockResolvedValue({ qrId: 'qr-9', qrCode: 'b64', qrLink: 'https://qr', payload: 'p', expiresAt: new Date() });
});

describe('СБП QR — после подтверждения оператором', () => {
  it('подтверждённая бронь получает QR, статус брони не меняется', async () => {
    queryMock.mockImplementation((sql: string) =>
      Promise.resolve(sql.includes('SELECT') ? { rows: [booking({})] } : { rows: [], rowCount: 1 }),
    );
    const res = await POST(post({ bookingId: 12 }));
    expect(res.status).toBe(200);
    const update = queryMock.mock.calls.map(([q]) => String(q)).find((q) => q.includes('UPDATE operator_bookings'));
    expect(update).toBeDefined();
    expect(update).not.toMatch(/pending_payment/);
    expect(update).toMatch(/tochka_qr_id IS NULL/);
  });

  it('новая заявка — 409 «после подтверждения», банк не спрашивается', async () => {
    queryMock.mockResolvedValue({ rows: [booking({ booking_status: 'new' })] });
    const res = await POST(post({ bookingId: 12 }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'not_confirmed' });
    expect(createQrMock).not.toHaveBeenCalled();
  });

  it('оплаченная и отменённая брони QR не получают', async () => {
    queryMock.mockResolvedValue({ rows: [booking({ paid_at: new Date() })] });
    expect((await (await POST(post({ bookingId: 12 }))).json()).code).toBe('already_paid');
    queryMock.mockResolvedValue({ rows: [booking({ booking_status: 'cancelled' })] });
    expect((await (await POST(post({ bookingId: 12 }))).json()).code).toBe('not_payable');
    expect(createQrMock).not.toHaveBeenCalled();
  });

  it('QR не привязался к брони — туристу его не отдают', async () => {
    queryMock.mockImplementation((sql: string) =>
      Promise.resolve(sql.includes('SELECT') ? { rows: [booking({})] } : { rows: [], rowCount: 0 }),
    );
    const res = await POST(post({ bookingId: 12 }));
    expect(res.status).toBe(409);
    expect(await res.json()).not.toHaveProperty('qrCode');
  });

  it('опрос: «оплачено» — это записанная оплата, а не статус confirmed', async () => {
    queryMock.mockResolvedValue({ rows: [{ booking_status: 'confirmed', paid_at: null }] });
    const req = { nextUrl: new URL('http://localhost/api/payments/tochka/qr?bookingId=12') } as unknown as NextRequest;
    expect(await (await GET(req)).json()).toMatchObject({ paid: false });
    queryMock.mockResolvedValue({ rows: [{ booking_status: 'confirmed', paid_at: new Date() }] });
    expect(await (await GET(req)).json()).toMatchObject({ paid: true });
  });

  it('чат Кузьмича не выдаёт QR на новую заявку', () => {
    expect(read('app/kuzmich/_KuzmichClient.tsx')).not.toMatch(/\/api\/payments\/tochka\/qr/);
  });
});

describe('оплата тура пишется в tour_payments во всех приёмниках', () => {
  it('СБП Точки — общей дверью, в транзакции с подтверждением', () => {
    const src = read('app/api/payments/tochka/webhook/route.ts');
    expect(src).toMatch(/await holdTourPayment\(client, booking\.id/);
    expect(src).toMatch(/booking_status IN \('confirmed', 'pending_payment'\)/);
  });

  it('CloudPayments: бронь из кабинета и бронь с сайта', () => {
    const src = read('app/api/payments/webhook/route.ts');
    expect(src).toMatch(/await holdTourPayment\(client, b\.id/);
    expect(src).toMatch(/release_after = \$\{RELEASE_AFTER_SQL\}/);
  });

  it('кабинетный CloudPayments — общей дверью', () => {
    expect(read('app/api/hub/operator/payments/webhook/route.ts')).toMatch(/await holdTourPayment\(client, bookingId/);
  });
});

describe('срок выплаты оператору — от конца тура', () => {
  it('ни один приёмник не считает выплату от момента оплаты', () => {
    for (const f of [
      'app/api/payments/webhook/route.ts',
      'app/api/hub/operator/payments/webhook/route.ts',
      'app/api/payments/tochka/webhook/route.ts',
      'lib/payments/hold-tour-payment.ts',
    ]) {
      expect(code(f), f).not.toMatch(/release_after\s*=\s*NOW\(\)/);
    }
  });

  it('конец тура — end_date, у старых броней — число дней тура; плюс 36 часов', () => {
    const src = read('lib/payments/hold-tour-payment.ts');
    expect(src).toMatch(/COALESCE\(ob\.end_date, ob\.booking_date \+/);
    expect(src).toMatch(/INTERVAL '36 hours'/);
  });
});

describe('CloudPayments-приёмник: порядок и сумма', () => {
  const src = code('app/api/payments/webhook/route.ts');

  it('туры разбираются ДО таблицы payments, которой на проде нет', () => {
    const tour = src.indexOf('await handleHubBookingPayment(invoice');
    const legacy = src.indexOf('UPDATE payments');
    expect(tour).toBeGreaterThan(-1);
    expect(legacy).toBeGreaterThan(tour);
  });

  it('сумма сверяется с бронью и с платежом', () => {
    expect((src.match(/amountMatches\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('отказ записи не глушится', () => {
    expect(src).toMatch(/console\.error\('\[payments\/webhook\] отказ обработки:'/);
  });
});

describe('ON CONFLICT по частичному индексу cp_transaction_id несёт предикат', () => {
  // Индекс idx_tour_payments_cp_tx частичный (WHERE cp_transaction_id IS NOT
  // NULL). Без того же предиката Postgres не выводит арбитра и отвечает 42P10
  // на ВЫПОЛНЕНИИ — PREPARE проходит, поэтому sql-shape-check этого не видит.
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(name)) out.push(p);
    }
    return out;
  }

  it('во всём app/ и lib/', () => {
    const bad: string[] = [];
    for (const f of [...walk(join(process.cwd(), 'app')), ...walk(join(process.cwd(), 'lib'))]) {
      const src = readFileSync(f, 'utf-8');
      for (const m of src.matchAll(/ON CONFLICT \(cp_transaction_id\)([^\n`]*)/g)) {
        if (!/WHERE cp_transaction_id IS NOT NULL/.test(m[1])) bad.push(f.replace(process.cwd() + '/', ''));
      }
    }
    expect(bad).toEqual([]);
  });
});
