/**
 * Приёмники оплаты не молчат об отказе побочной работы (аудит 15.10, W2-3;
 * P4-03, п. 1.12).
 *
 * В двух приёмниках — СБП Точки и CloudPayments — стояло семь пустых catch:
 * уведомления владельцу и оператору, счётчик занятости, журнал действий,
 * письма туристу. Всё это работа ПОСЛЕ записи оплаты, и глушить отказ там
 * намеренно — повтор вебхука до неё не дойдёт, а 503 после подтверждения
 * нельзя. Но «гасить» и «молчать» — разное (CLAUDE.md §4.0): сбой должен
 * назваться в логе областью и кодом отказа, иначе «оператору не пришло
 * уведомление об оплате» разбирать не по чему.
 *
 * Правка — только лог. Ответ, статус и порядок записи остаются прежними, и
 * это проверяется здесь же: каждый случай сверяет ответ с тем, что приёмник
 * отдавал до правки.
 *
 * Сторож судит поведение: зовёт настоящие обработчики с подменённой базой и
 * сетью, которые роняют ровно ветку каждого catch. Проверяется, что видит
 * человек, читающий лог: область, код отказа (SQLSTATE у базы) — и что в логе
 * нет ПД из тела вебхука и из базы (§7, 152-ФЗ).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import { NextRequest } from 'next/server';

const { dbMock, statusMock, fetchMock } = vi.hoisted(() => ({
  dbMock: vi.fn(),
  statusMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (...a: unknown[]) => dbMock(...a),
    connect: async () => ({ query: (...a: unknown[]) => dbMock(...a), release: () => undefined }),
  },
}));
vi.mock('@/lib/payments/tochka', () => ({
  getSBPPaymentStatus: (...a: unknown[]) => statusMock(...a),
}));
// Комиссия и фонд — свои двери со своими сторожами; здесь судим только catch
// приёмников, поэтому они отвечают успехом и в базу не ходят.
vi.mock('@/lib/payments/commission', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/commission')>()),
  recordCommissionFromBooking: vi.fn(async () => undefined),
}));
vi.mock('@/lib/compute-fund', () => ({
  addBookingContribution: vi.fn(async () => undefined),
}));

import { POST as tochkaPOST } from '@/app/api/payments/tochka/webhook/route';
import { POST as cloudPaymentsPOST } from '@/app/api/payments/webhook/route';

// ── ПД, которые не должны попасть в лог ни при каком отказе ────────────────
const PHONE = '+7 914 555-12-34';
const PHONE_DIGITS = '79145551234';
const EMAIL = 'turist.private@example.com';
const NAME = 'Анна Приватная';
const CARD_FIRST_SIX = '427600';
const CARD_LAST_FOUR = '9876';
const PD = [PHONE, PHONE_DIGITS, EMAIL, NAME, CARD_FIRST_SIX, CARD_LAST_FOUR];

/** Отказ базы в форме pg: код — SQLSTATE, в `detail` база кладёт значения строки. */
function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, severity: 'ERROR', detail: `Key (phone)=(${PHONE}) — ${EMAIL}` });
}

/** Сеть до Telegram не дошла — так отказывает fetch в Node: кода у ошибки нет, он в cause. */
function fetchFailed(): Error {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

/** Коды отказов, названных в логе этой областью. */
function namedFailures(scope: string): string[] {
  return errorSpy.mock.calls
    .filter(([head, info]) => typeof head === 'string' && head.startsWith(`[${scope}]`)
      && typeof info === 'object' && info !== null && 'code' in info)
    .map(([, info]) => String((info as { code: unknown }).code));
}

/** Всё, что ушло в консоль за тест, — одним текстом, как его увидит читающий лог. */
function everythingLogged(): string {
  return [errorSpy, warnSpy, logSpy]
    .flatMap((s) => s.mock.calls)
    .map((args) => args.map((a: unknown) => (typeof a === 'string' ? a : inspect(a, { depth: 5 }))).join(' '))
    .join('\n');
}

function expectNoPD(): void {
  const text = everythingLogged();
  for (const value of PD) expect(text, `в логе ПД: ${value}`).not.toContain(value);
}

beforeEach(() => {
  dbMock.mockReset();
  statusMock.mockReset();
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(fetchFailed());
  vi.stubGlobal('fetch', fetchMock);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
  vi.stubEnv('TELEGRAM_OWNER_ID', '1');
  vi.stubEnv('CLOUDPAYMENTS_API_SECRET', 'test-secret');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ── СБП Точки ──────────────────────────────────────────────────────────────

const TOCHKA = 'tochka/webhook';
const BOOKING = { id: 7, final_price: 12000, tourist_name: NAME, paid_at: null };
const TOCHKA_BODY = {
  event: 'payment.completed',
  qrcId: 'qr-1',
  amount: 1_200_000,
  currency: 'RUB',
  transactionDate: '2026-10-15T10:00:00Z',
  // Поля, которых приёмник не читает, но банк или подделка может прислать.
  payer: { phone: PHONE, email: EMAIL, name: NAME },
};

function tochkaRequest(body: unknown) {
  return { json: async () => body } as unknown as Parameters<typeof tochkaPOST>[0];
}

/**
 * База приёмника Точки: бронь находится, подтверждение даёт `confirmRows`
 * строк, ушедшая бронь — отменена, а счётчик занятости и журнал действий
 * отказывают своими SQLSTATE.
 */
function tochkaDb(confirmRows: number) {
  dbMock.mockImplementation((sql: unknown) => {
    const q = String(sql);
    if (q.includes('WHERE tochka_qr_id')) return Promise.resolve({ rows: [BOOKING] });
    if (q.includes("SET booking_status = 'confirmed'")) return Promise.resolve({ rows: [], rowCount: confirmRows });
    if (q.includes('SELECT booking_status, paid_at')) return Promise.resolve({ rows: [{ booking_status: 'cancelled', paid_at: null }] });
    if (q.includes('UPDATE tour_availability')) return Promise.reject(pgError('40P01', 'deadlock detected'));
    if (q.includes('INSERT INTO ai_actions_log')) return Promise.reject(pgError('42P01', 'relation "ai_actions_log" does not exist'));
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

describe('СБП Точки: отказ побочной работы назван, ответ прежний', () => {
  it('сумма не совпала, уведомление владельцу не ушло — 200 «не подтверждено», отказ в логе', async () => {
    tochkaDb(1);
    statusMock.mockResolvedValue({ qrId: 'qr-1', status: 'paid', amount: 1, paidAt: new Date() });

    const res = await tochkaPOST(tochkaRequest(TOCHKA_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, confirmed: false });

    // Уведомление идёт без ожидания — отказ приходит после ответа.
    await vi.waitFor(() => expect(namedFailures(TOCHKA)).toEqual(['нет кода']), { timeout: 1000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expectNoPD();
  });

  it('бронь ушла из ожидания, владельцу не дозвонились — 200 с причиной, отказ в логе', async () => {
    tochkaDb(0);
    statusMock.mockResolvedValue({ qrId: 'qr-1', status: 'paid', amount: 12000, paidAt: new Date() });

    const res = await tochkaPOST(tochkaRequest(TOCHKA_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true, confirmed: false, reason: 'booking_left_pending', booking_status: 'cancelled',
    });

    await vi.waitFor(() => expect(namedFailures(TOCHKA)).toEqual(['нет кода']), { timeout: 1000 });
    expectNoPD();
  });

  it('оплата записана, а счётчик, журнал и уведомление оператору отказали — 200, три отказа в логе со своими кодами', async () => {
    tochkaDb(1);
    statusMock.mockResolvedValue({ qrId: 'qr-1', status: 'paid', amount: 12000, paidAt: new Date() });

    const res = await tochkaPOST(tochkaRequest(TOCHKA_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // Счётчик (40P01) и журнал (42P01) ждутся до ответа, уведомление — нет.
    await vi.waitFor(() => expect(namedFailures(TOCHKA)).toHaveLength(3), { timeout: 1000 });
    expect(namedFailures(TOCHKA).sort()).toEqual(['40P01', '42P01', 'нет кода']);
    expectNoPD();
  });
});

describe('СБП Точки: главный путь отказа называет причину, ответ прежний — 503 с повтором', () => {
  it('подтверждение упало в базе — 503 processing_failed, в логе область и SQLSTATE, ПД нет', async () => {
    dbMock.mockImplementation((sql: unknown) => {
      const q = String(sql);
      if (q.includes('WHERE tochka_qr_id')) return Promise.resolve({ rows: [BOOKING] });
      if (q.includes("SET booking_status = 'confirmed'")) return Promise.reject(pgError('57014', 'canceling statement due to statement timeout'));
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    statusMock.mockResolvedValue({ qrId: 'qr-1', status: 'paid', amount: 12000, paidAt: new Date() });

    const res = await tochkaPOST(tochkaRequest(TOCHKA_BODY));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, retry: true, reason: 'processing_failed' });
    expect(namedFailures(TOCHKA)).toEqual(['57014']);
    expect(everythingLogged()).toContain('обработка оплаты (ответ 503, Точка повторит) не выполнен');
    expectNoPD();
  });
});

// ── CloudPayments ──────────────────────────────────────────────────────────

const CP = 'payments/webhook';

function cloudPaymentsRequest(status: 'Completed' | 'Declined') {
  const body = JSON.stringify({
    TransactionId: 555,
    Amount: 12000,
    Currency: 'RUB',
    PaymentAmount: 12000,
    PaymentCurrency: 'RUB',
    // Не число и не UUID — счёт старого пути через таблицу `payments`.
    InvoiceId: 'inv-legacy-1',
    AccountId: EMAIL,
    Email: EMAIL,
    Name: NAME,
    DateTime: '2026-10-15 10:00:00',
    TestMode: false,
    Status: status,
    Reason: status === 'Declined' ? 'Insufficient funds' : undefined,
    CardFirstSix: CARD_FIRST_SIX,
    CardLastFour: CARD_LAST_FOUR,
    CardType: 'Visa',
    Data: { phone: PHONE },
  });
  const signature = createHmac('sha256', 'test-secret').update(body).digest('base64');
  return new NextRequest('http://localhost/api/payments/webhook', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', 'X-Content-HMAC': signature },
  });
}

/**
 * База приёмника CloudPayments: старый путь `payments` проходит запись, а
 * чтение для письма туристу отказывает своим SQLSTATE.
 */
function cloudPaymentsDb() {
  dbMock.mockImplementation((sql: unknown) => {
    const q = String(sql);
    if (q.includes('UPDATE payments') && q.includes('RETURNING')) {
      return Promise.resolve({ rows: [{ booking_id: '5', booking_type: 'tour', user_id: 'u-1' }], rowCount: 1 });
    }
    if (q.includes('UPDATE payments')) return Promise.resolve({ rows: [], rowCount: 1 });
    if (q.includes('t.title as tour_name')) return Promise.reject(pgError('42703', 'column b.start_date does not exist'));
    if (q.includes('FROM payments p')) return Promise.reject(pgError('42P01', 'relation "payments" does not exist'));
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

describe('CloudPayments: отказ письма туристу назван, ответ прежний', () => {
  it('оплата прошла, письмо не собралось — ответ code 0, отказ с SQLSTATE в логе', async () => {
    cloudPaymentsDb();
    const res = await cloudPaymentsPOST(cloudPaymentsRequest('Completed'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: 0 });
    expect(namedFailures(CP)).toEqual(['42703']);
    expectNoPD();
  });

  it('платёж отклонён, письмо не собралось — ответ code 0, отказ с SQLSTATE в логе', async () => {
    cloudPaymentsDb();
    const res = await cloudPaymentsPOST(cloudPaymentsRequest('Declined'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ code: 0 });
    expect(namedFailures(CP)).toEqual(['42P01']);
    expectNoPD();
  });
});
