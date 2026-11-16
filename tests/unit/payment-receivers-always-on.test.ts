/**
 * Приёмники оплаты на граничных уведомлениях (#3433 п. 2, слово владельца
 * 16.11 «Да, всё одним PR», формат — «Разбирать оба»).
 *
 * Вызовом настоящих обработчиков с подменённой базой: бронь живёт в памяти
 * теста, база отвечает на запросы приёмника по их смыслу. SQL этих запросов
 * проверен на PostgreSQL 16 (PR).
 *
 * Что держит:
 *  - отказ и отмена по карте не меняют статус брони и не трогают оплаченную;
 *    отмена по оплаченной — тревога человеку;
 *  - поздний Pending не переписывает «оплачено»;
 *  - не та сумма, вторая оплата другой операцией, счёт без брони — тревога
 *    человеку без ПД, банку — «принято»; повтор той же операции — тишина;
 *  - отказ базы в приёмнике оператора — 500 (CloudPayments повторит), а не «принято»;
 *  - комиссия пишется на клиенте транзакции оплаты, её отказ откатывается до
 *    точки сохранения и оплату не роняет;
 *  - уведомление в форме (по умолчанию у CloudPayments) разбирается, как JSON;
 *  - имя туриста из СБП-приёмника уходит только в MAX.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';

interface Booking {
  id: string; final_price: string; payment_status: string | null; booking_status: string;
  payment_id: string | null; paid_at: Date | null; tourist_name: string; tourist_email: string | null;
}

const m = vi.hoisted(() => ({
  booking: null as null | Booking,
  calls: [] as Array<{ sql: string; params: unknown[]; tx: boolean }>,
  failLock: null as null | Error,
  failCommission: null as null | Error,
  tgSend: vi.fn(),
  pdAlert: vi.fn(),
  notifyPaid: vi.fn(),
  bankStatus: vi.fn(),
}));

function handle(sqlIn: unknown, params: unknown[] = [], tx = false): { rows: unknown[]; rowCount: number } {
  const sql = String(sqlIn).replace(/\s+/g, ' ').trim();
  m.calls.push({ sql, params, tx });
  const b = m.booking;
  const paid = !!b && (b.paid_at !== null || b.payment_status === 'paid');
  if (/FROM operator_bookings/.test(sql) && /FOR UPDATE/.test(sql) && /final_price/.test(sql)) {
    if (m.failLock) throw m.failLock;
    return { rows: b ? [{ ...b }] : [], rowCount: b ? 1 : 0 };
  }
  if (/^SELECT booking_status FROM operator_bookings/.test(sql)) {
    return { rows: b ? [{ booking_status: b.booking_status }] : [], rowCount: b ? 1 : 0 };
  }
  if (/^UPDATE operator_bookings/.test(sql) && /SET payment_status = 'paid'/.test(sql) && b && !paid) {
    b.payment_status = 'paid';
    b.paid_at = new Date();
    if (['confirmed', 'pending_payment'].includes(b.booking_status)) b.booking_status = 'confirmed';
    return { rows: [], rowCount: 1 };
  }
  if (/^WITH b AS/.test(sql) && /payment_status = 'failed'/.test(sql)) {
    if (!b) return { rows: [], rowCount: 0 };
    if (!paid) b.payment_status = 'failed';
    return { rows: [{ paid }], rowCount: 1 };
  }
  if (/SET payment_status = 'pending'/.test(sql) && /paid_at IS NULL/.test(sql)) {
    if (b && !paid) b.payment_status = 'pending';
    return { rows: [], rowCount: b && !paid ? 1 : 0 };
  }
  if (/^INSERT INTO operator_commissions/.test(sql) && m.failCommission) throw m.failCommission;
  // Точка: бронь по QR и её подтверждение.
  if (/WHERE tochka_qr_id/.test(sql)) {
    return { rows: b ? [{ id: Number(b.id), final_price: Number(b.final_price), tourist_name: b.tourist_name, paid_at: b.paid_at }] : [], rowCount: b ? 1 : 0 };
  }
  if (/SET booking_status = 'confirmed', payment_status = 'paid'/.test(sql) && b && !paid) {
    b.payment_status = 'paid'; b.paid_at = new Date();
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

vi.mock('@/lib/database', () => ({
  query: async (sql: unknown, params?: unknown[]) => handle(sql, params, false),
  transaction: async <T,>(fn: (c: { query: (s: unknown, p?: unknown[]) => Promise<unknown> }) => Promise<T>) => {
    const client = { query: async (s: unknown, p?: unknown[]) => handle(s, p, true) };
    return fn(client);
  },
}));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: async (sql: unknown, params?: unknown[]) => handle(sql, params, false) },
}));
vi.mock('@/lib/notifications/tg-send', () => ({ tgSend: (...a: unknown[]) => m.tgSend(...a) }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: (...a: unknown[]) => m.pdAlert(...a) }));
vi.mock('@/lib/notifications/operator-booking', () => ({ notifyBookingPaid: (...a: unknown[]) => m.notifyPaid(...a) }));
vi.mock('@/lib/compute-fund', () => ({ addBookingContribution: vi.fn(async () => undefined) }));
vi.mock('@/lib/payments/tochka', () => ({ getSBPPaymentStatus: (...a: unknown[]) => m.bankStatus(...a) }));
vi.mock('@/lib/notifications/email-service', () => ({ emailService: { sendEmail: vi.fn(async () => ({ success: true })) } }));

const hub = await import('@/app/api/hub/operator/payments/webhook/route');
const main = await import('@/app/api/payments/webhook/route');
const tochka = await import('@/app/api/payments/tochka/webhook/route');
const { recordCommissionFromBooking } = await import('@/lib/payments/commission');

const SECRET = 'test-secret';
const NAME = 'Анна Приватная';
const EMAIL = 'turist.private@example.com';

function booking(over: Partial<Booking> = {}): Booking {
  return {
    id: '41', final_price: '12000', payment_status: 'pending', booking_status: 'confirmed',
    payment_id: null, paid_at: null, tourist_name: NAME, tourist_email: EMAIL, ...over,
  };
}

function fields(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    TransactionId: 555, Amount: 12000, Currency: 'RUB', PaymentAmount: 12000, PaymentCurrency: 'RUB',
    InvoiceId: '41', AccountId: EMAIL, Email: EMAIL, DateTime: '2026-11-16 10:00:00', TestMode: false,
    Status: 'Completed', CardType: 'Visa', ...over,
  };
}

function signed(body: string, url: string, contentType = 'application/json') {
  const signature = createHmac('sha256', SECRET).update(body).digest('base64');
  return new NextRequest(url, { method: 'POST', body, headers: { 'content-type': contentType, 'X-Content-HMAC': signature } });
}
const hubPost = (f: Record<string, unknown>) => hub.POST(signed(JSON.stringify(f), 'http://localhost/api/hub/operator/payments/webhook'));
const mainPost = (f: Record<string, unknown>) => main.POST(signed(JSON.stringify(f), 'http://localhost/api/payments/webhook'));

/** Тексты тревог человеку. */
const alerts = () => m.tgSend.mock.calls.map((c) => String(c[1]));
const noPd = () => { for (const t of alerts()) { expect(t).not.toContain(NAME); expect(t).not.toContain(EMAIL); } };
const commissionInserts = () => m.calls.filter((c) => /^INSERT INTO operator_commissions/.test(c.sql));

beforeEach(() => {
  m.booking = booking();
  m.calls = [];
  m.failLock = null;
  m.failCommission = null;
  m.tgSend.mockReset().mockResolvedValue({ ok: true });
  m.pdAlert.mockReset().mockResolvedValue({ channel: 'max', delivered: true });
  m.notifyPaid.mockReset().mockResolvedValue(undefined);
  m.bankStatus.mockReset();
  vi.stubEnv('CLOUDPAYMENTS_API_SECRET', SECRET);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('отказ и отмена по карте не трогают бронь (приёмник оператора и основной)', () => {
  for (const [name, post] of [['оператора', hubPost], ['основной', mainPost]] as const) {
    it(`${name}: отказ по подтверждённой неоплаченной брони — бронь подтверждена, отметка «failed», ответ «принято»`, async () => {
      const res = await post(fields({ Status: 'Declined' }));
      expect(await res.json()).toEqual({ code: 0 });
      expect(m.booking).toMatchObject({ booking_status: 'confirmed', payment_status: 'failed' });
      expect(m.calls.some((c) => /booking_status = 'cancelled'/.test(c.sql))).toBe(false);
      expect(m.calls.some((c) => /\bpayments\b/.test(c.sql.replace(/tour_payments/g, '')))).toBe(false);
    });

    it(`${name}: отмена по оплаченной брони — бронь и оплата не тронуты, тревога человеку без ПД`, async () => {
      m.booking = booking({ payment_status: 'paid', paid_at: new Date(), payment_id: '555' });
      await post(fields({ Status: 'Cancelled' }));
      expect(m.booking).toMatchObject({ booking_status: 'confirmed', payment_status: 'paid' });
      expect(alerts().join('\n')).toMatch(/отказ или отмена платежа по уже оплаченной брони/);
      noPd();
    });

    it(`${name}: поздний Pending не переписывает «оплачено»`, async () => {
      m.booking = booking({ payment_status: 'paid', paid_at: new Date(), payment_id: '555' });
      await post(fields({ Status: 'Pending' }));
      expect(m.booking?.payment_status).toBe('paid');
    });
  }
});

describe('деньги без записи — тревога человеку, банку «принято»', () => {
  for (const [name, post] of [['оператора', hubPost], ['основной', mainPost]] as const) {
    it(`${name}: не та сумма — бронь не оплачена, тревога с суммами, без ПД`, async () => {
      const res = await post(fields({ Amount: 9000, PaymentAmount: 9000 }));
      expect(await res.json()).toEqual({ code: 0 });
      expect(m.booking?.paid_at).toBeNull();
      expect(alerts().join('\n')).toMatch(/сумма оплаты не совпала с бронью[\s\S]*Ожидалось: 12[\s ]000 р\.[\s\S]*Оплачено: 9[\s ]000 р\./);
      noPd();
    });

    it(`${name}: вторая оплата другой операцией — тревога «деньги взяты дважды»; повтор той же — тишина`, async () => {
      m.booking = booking({ payment_status: 'paid', paid_at: new Date(), payment_id: '555' });
      await post(fields({ TransactionId: 555 }));
      expect(m.tgSend).not.toHaveBeenCalled();
      await post(fields({ TransactionId: 777 }));
      expect(alerts().join('\n')).toMatch(/вторая оплата уже оплаченной брони/);
      expect(commissionInserts()).toHaveLength(0);
      noPd();
    });

    it(`${name}: брони нет — тревога «не сопоставлена», ответ «принято»`, async () => {
      m.booking = null;
      const res = await post(fields());
      expect(await res.json()).toEqual({ code: 0 });
      expect(alerts().join('\n')).toMatch(/оплата не сопоставлена ни с одной бронью/);
    });
  }

  it('основной: счёт ни бронь, ни UUID — тревога, а не 500 по таблице payments', async () => {
    const res = await mainPost(fields({ InvoiceId: 'inv-legacy-1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: 0 });
    expect(alerts().join('\n')).toMatch(/не сопоставлена/);
  });
});

describe('приёмник оператора: отказ базы — повтор, а не «принято»', () => {
  it('блокировка брони упала — 500, CloudPayments повторит', async () => {
    m.failLock = Object.assign(new Error('could not obtain lock'), { code: '55P03' });
    const res = await hubPost(fields());
    expect(res.status).toBe(500);
    expect(m.booking?.paid_at).toBeNull();
  });
});

describe('комиссия — в транзакции оплаты', () => {
  for (const [name, post] of [['оператора', hubPost], ['основной', mainPost]] as const) {
    it(`${name}: оплата подтверждённой брони — вставка комиссии на клиенте транзакции под точкой сохранения`, async () => {
      await post(fields());
      expect(m.booking?.paid_at).not.toBeNull();
      const inserts = commissionInserts();
      expect(inserts).toHaveLength(1);
      expect(inserts[0].tx).toBe(true);
      const txSql = m.calls.filter((c) => c.tx).map((c) => c.sql);
      expect(txSql).toContain('SAVEPOINT commission_record');
      expect(txSql).toContain('RELEASE SAVEPOINT commission_record');
    });

    it(`${name}: неподтверждённая бронь (new) — оплата записана, комиссии нет, тревога человеку`, async () => {
      m.booking = booking({ booking_status: 'new' });
      await post(fields());
      expect(m.booking?.paid_at).not.toBeNull();
      expect(m.booking?.booking_status).toBe('new');
      expect(commissionInserts()).toHaveLength(0);
      expect(alerts().join('\n')).toMatch(/неподтверждённую бронь/);
    });
  }

  it('отказ вставки комиссии откатывается до точки сохранения и не роняет оплату', async () => {
    m.failCommission = Object.assign(new Error('relation "operator_commissions" does not exist'), { code: '42P01' });
    const res = await hubPost(fields());
    expect(res.status).toBe(200);
    expect(m.booking?.paid_at).not.toBeNull();
    expect(m.calls.filter((c) => c.tx).map((c) => c.sql)).toContain('ROLLBACK TO SAVEPOINT commission_record');
  });

  it('без клиента — прежний путь через пул, точки сохранения нет', async () => {
    await recordCommissionFromBooking('41', 'inv-1');
    expect(m.calls.map((c) => c.sql).some((s) => /SAVEPOINT/.test(s))).toBe(false);
    expect(commissionInserts()[0].tx).toBe(false);
  });
});

describe('формат уведомления: форма разбирается, как JSON', () => {
  it('Pay формой (по умолчанию у CloudPayments) — оплата записана', async () => {
    const form = new URLSearchParams(Object.entries(fields()).map(([k, v]) => [k, String(v)])).toString();
    const res = await main.POST(signed(form, 'http://localhost/api/payments/webhook', 'application/x-www-form-urlencoded'));
    expect(await res.json()).toEqual({ code: 0 });
    expect(m.booking?.paid_at).not.toBeNull();
  });

  it('форма с неверной подписью — отказ, бронь не тронута', async () => {
    const form = new URLSearchParams(Object.entries(fields()).map(([k, v]) => [k, String(v)])).toString();
    const req = new NextRequest('http://localhost/api/payments/webhook', {
      method: 'POST', body: form, headers: { 'X-Content-HMAC': 'forged' },
    });
    expect((await main.POST(req)).status).toBe(400);
    expect(m.booking?.paid_at).toBeNull();
  });
});

describe('СБП Точка: комиссия в транзакции, имя туриста — только в MAX', () => {
  const tochkaReq = () => ({ json: async () => ({ event: 'payment.completed', qrcId: 'qr-1', amount: 1_200_000 }) }) as unknown as Parameters<typeof tochka.POST>[0];

  it('оплата подтверждена — комиссия на клиенте транзакции; уведомление: имя в тексте для MAX, в заглушке — нет', async () => {
    m.bankStatus.mockResolvedValue({ qrId: 'qr-1', status: 'paid', amount: 12000, paidAt: new Date() });
    const res = await tochka.POST(tochkaReq());
    expect(await res.json()).toEqual({ ok: true });
    expect(commissionInserts()).toHaveLength(1);
    expect(commissionInserts()[0].tx).toBe(true);
    await vi.waitFor(() => expect(m.pdAlert).toHaveBeenCalledTimes(1));
    const { text, stub } = m.pdAlert.mock.calls[0][0] as { text: string; stub: string };
    expect(text).toContain(NAME);
    expect(stub).not.toContain(NAME);
    expect(stub).toContain('Бронирование: #41');
  });
});
