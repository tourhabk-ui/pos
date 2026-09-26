/**
 * tests/unit/stay-pay-on-site.test.ts
 *
 * Жильё оплачивается НА МЕСТЕ (решение владельца 26.09): гость бронирует,
 * владелец подтверждает, гость платит владельцу при заселении. Онлайн-оплаты
 * жилья через платформу нет — и, значит, нет и возврата через платформу.
 *
 * До этого дня в продукте было ровно обратное (аудит жилья 26.09):
 * - book-роут звал /api/payments/create (таблицы payments на проде нет),
 *   глушил отказ и отдавал paymentUrl на несуществующую страницу;
 * - форма показывала «Оплатить» ДО подтверждения владельцем;
 * - вебхук ставил брони жилья status='confirmed' без условия на статус —
 *   оплата подменяла согласие владельца и «оживляла» отменённую бронь, а в
 *   журнал фонда жильё писалось как booking_tour;
 * - уведомление поручало владельцу «перевести вручную по CloudPayments»
 *   деньги, которых у него не было, и он мог отметить «возврат выполнен»;
 * - карточка «Оплачено» в кабинете владельца суммировала payment_status
 *   'paid', который при оплате на месте не наступает никогда.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
/** Код без комментариев: история в комментариях цитирует прежние тексты. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...a: unknown[]) => queryMock(...a),
  transaction: async (fn: (c: { query: (...a: unknown[]) => unknown }) => unknown) =>
    fn({ query: (...a: unknown[]) => queryMock(...a) }),
}));

const requireAuthMock = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: (...a: unknown[]) => requireAuthMock(...a),
}));

const sendEmailMock = vi.fn();
vi.mock('@/lib/notifications/email-service', () => ({
  emailService: { sendEmail: (...a: unknown[]) => sendEmailMock(...a) },
}));

vi.mock('@/lib/notifications/stay-booking', async () => {
  const pay = await import('@/lib/stay/pay-on-site');
  return {
    notifyNewStayBooking: vi.fn().mockResolvedValue(undefined),
    logStayFailure: vi.fn(),
    STAY_PAY_ON_SITE: pay.STAY_PAY_ON_SITE,
  };
});

import { POST as postBooking } from '@/app/api/accommodations/[id]/book/route';

const ACC_ID = '33333333-3333-4333-8333-333333333333';
const ROOM_ID = '55555555-5555-4555-8555-555555555555';

function book() {
  return postBooking(
    new Request(`http://localhost/api/accommodations/${ACC_ID}/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: ROOM_ID, checkInDate: '2099-08-01', checkOutDate: '2099-08-03', adults: 2 }),
    }) as unknown as NextRequest,
    { params: Promise.resolve({ id: ACC_ID }) },
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  queryMock.mockReset();
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ success: true });
  requireAuthMock.mockResolvedValue({ userId: 'guest-1', role: 'tourist' });
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { paymentId: 'p' } }) });
  vi.stubGlobal('fetch', fetchMock);
  queryMock.mockImplementation((sql: string) => {
    if (sql.includes('pg_advisory_xact_lock')) return Promise.resolve({ rows: [] });
    if (sql.includes('AS holding')) return Promise.resolve({ rows: [{ holding: 0 }] });
    if (sql.includes('CROSS JOIN generate_series')) {
      return Promise.resolve({ rows: [
        { night: '2099-08-01', blocked: false, free_units: 2 },
        { night: '2099-08-02', blocked: false, free_units: 2 },
      ] });
    }
    if (sql.includes('FROM accommodation_rooms r')) {
      return Promise.resolve({ rows: [{
        id: ROOM_ID, accommodation_id: ACC_ID, name: 'Люкс', max_guests: 4,
        available_rooms: 2, price_per_night: '9000', accommodation_name: 'Дом', is_active: true,
      }] });
    }
    if (sql.includes('FROM accommodation_availability')) return Promise.resolve({ rows: [] });
    if (sql.includes('INSERT INTO accommodation_bookings')) return Promise.resolve({ rows: [{ id: 'booking-1' }] });
    if (sql.includes('FROM users')) return Promise.resolve({ rows: [{ email: 'g@x.ru', name: 'Гость', phone: null }] });
    if (sql.includes('telegram_chat_id')) return Promise.resolve({ rows: [] });
    throw new Error('unexpected SQL: ' + sql);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('book-роут: бронь без онлайн-платежа', () => {
  it('платёж не создаётся, ссылки на оплату нет, ответ говорит про оплату на месте', async () => {
    const res = await book();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(body.data.paymentUrl).toBeUndefined();
    expect(body.data.payment).toBe('on_site');
    expect(body.data.paymentNote).toMatch(/владельцу при заселении/);
    expect(body.data.status).toBe('pending');
  });

  it('письмо гостю: заявка, а не подтверждение, и оплата на месте', async () => {
    await book();
    const mail = sendEmailMock.mock.calls[0][0] as { html: string };
    expect(mail.html).toContain('Заявка на бронирование принята');
    expect(mail.html).toMatch(/владельцу при заселении/);
    expect(mail.html).not.toMatch(/Оплатить|ссылк[аи] на оплату/);
  });

  it('insert пишет payment_status pending — платформа оплату не принимала', async () => {
    await book();
    const insert = queryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO accommodation_bookings'))!;
    const params = insert[1] as unknown[];
    expect(params[11]).toBe('pending');
    expect(params[12]).toBe('pending');
  });
});

describe('платёжные двери закрыты для жилья', () => {
  it('/api/payments/create отказывает брони жилья до записи платежа', () => {
    const src = code('app/api/payments/create/route.ts');
    const refuse = src.indexOf("if (bookingType === 'accommodation')");
    expect(refuse).toBeGreaterThan(0);
    expect(refuse).toBeLessThan(src.indexOf('INSERT INTO payments'));
    expect(src).toContain('status: 409');
  });

  it('вебхук: оплата жилья не подтверждает бронь и не трогает отменённую', () => {
    const src = code('app/api/payments/webhook/route.ts');
    const branch = src.slice(src.indexOf("case 'accommodation':"), src.indexOf("case 'transfer':"));
    expect(branch).toContain("SET payment_status = 'paid', updated_at = NOW()");
    expect(branch).toContain("WHERE id = $1 AND status IN ('pending', 'confirmed')");
    expect(branch).not.toMatch(/status = 'confirmed'/);
    expect(src).toContain("payment.booking_type === 'accommodation' ? 'booking_stay'");
  });

  it('форма брони гостя: ни виджета оплаты, ни кнопки «Оплатить»', () => {
    const form = code('components/booking/StayBookingForm.tsx');
    expect(form).not.toContain('CloudPaymentsWidget');
    expect(form).not.toMatch(/Оплатить/);
    expect(form).toContain('STAY_PAY_ON_SITE');
  });
});

describe('возврат не поручается владельцу', () => {
  it('кабинет владельца: нет кнопки «Возврат выполнен» и запроса refund_done', () => {
    const owner = code('app/hub/stay/bookings/_BookingsClient.tsx');
    expect(owner).not.toContain('refund_done');
    expect(owner).not.toContain('Возврат выполнен');
  });

  it('уведомление об отмене не зовёт переводить по CloudPayments', () => {
    const notify = code('lib/notifications/stay-booking.ts');
    expect(notify).not.toMatch(/Переведите вручную/);
  });

  it('ЛК гостя не обещает перевод от владельца', () => {
    const guest = code('app/hub/tourist/stays/_StaysClient.tsx');
    expect(guest).not.toMatch(/Перевод выполняет владелец/);
  });
});

describe('кабинет владельца не выдаёт сумму броней за полученные деньги', () => {
  it('stats: нет paid_revenue — оплату на месте платформа не видит', () => {
    const stats = code('app/api/stay/stats/route.ts');
    expect(stats).not.toContain('paid_revenue');
    expect(stats).not.toMatch(/payment_status = 'paid'/);
    expect(stats).toContain('bookingSums');
  });

  it('обзор: нет карточки «Оплачено»', () => {
    const dash = code('app/hub/stay/_StayDashboardClient.tsx');
    expect(dash).not.toMatch(/label: 'Оплачено'/);
    expect(dash).toContain('К оплате при заселении');
  });
});
