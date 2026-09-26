/**
 * tests/unit/stay-guest-notify.test.ts
 *
 * Гостю — о решении владельца по брони жилья (26.09). До этого дня PATCH
 * владельца уведомлял только владельца и админа: гость не узнавал ни о
 * подтверждении, ни об отмене, пока сам не открывал кабинет.
 *
 * Держится:
 * - письмо уходит на адрес гостя, причина отмены и название объекта —
 *   экранированы (текст ввёл человек, письмо читает другой человек);
 * - подтверждение говорит правду про деньги: оплата владельцу при
 *   заселении, никакой ссылки на оплату;
 * - Telegram — если привязан, push — через шлюз настроек (transactional);
 * - сбой канала не бросает, а пишется в лог БЕЗ адреса гостя (ПД);
 * - уведомление владельцу об отмене не поручает ему «перевести возврат».
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => queryMock(...a) }));

const sendEmailMock = vi.fn();
vi.mock('@/lib/notifications/email-service', () => ({
  emailService: { sendEmail: (...a: unknown[]) => sendEmailMock(...a) },
}));

const pushMock = vi.fn();
vi.mock('@/lib/notifications/web-push', () => ({
  sendPushToUser: (...a: unknown[]) => pushMock(...a),
}));

vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: vi.fn() }));
vi.mock('@/lib/config', () => ({ getPublicBaseUrl: () => 'https://vedarai.ru' }));

import { notifyStayGuestStatus, stayCancelMoneyLine } from '@/lib/notifications/stay-booking';

const base = {
  guestUserId: 'guest-1',
  bookingId: 'b-1',
  accommodationName: 'Дом <script>',
  roomName: 'Люкс',
  checkInDate: '2099-08-01',
  checkOutDate: '2099-08-03',
  totalPrice: 12000,
};

let errSpy: ReturnType<typeof vi.spyOn>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  queryMock.mockReset();
  sendEmailMock.mockReset();
  pushMock.mockReset();
  queryMock.mockResolvedValue({ rows: [{ email: 'guest@example.ru', telegram_id: '555' }] });
  sendEmailMock.mockResolvedValue({ success: true });
  pushMock.mockResolvedValue(undefined);
  fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
  process.env.TELEGRAM_BOT_TOKEN = 'token';
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  errSpy.mockRestore();
  delete process.env.TELEGRAM_BOT_TOKEN;
});

describe('notifyStayGuestStatus', () => {
  it('подтверждение: письмо гостю про оплату на месте, без ссылки на оплату', async () => {
    const r = await notifyStayGuestStatus({ ...base, status: 'confirmed' });
    expect(r.email).toBe('sent');
    const mail = sendEmailMock.mock.calls[0][0] as { to: string; subject: string; html: string };
    expect(mail.to).toBe('guest@example.ru');
    expect(mail.subject).toContain('подтверждена');
    expect(mail.html).toContain('при заселении');
    expect(mail.html).not.toMatch(/Оплатить|ссылк[аи] на оплату|payment/i);
    expect(mail.html).toContain('Дом &lt;script&gt;');
    expect(mail.html).not.toContain('<script>');
  });

  it('отмена: причина владельца экранирована в письме и в Telegram', async () => {
    const r = await notifyStayGuestStatus({
      ...base, status: 'cancelled', cancellationReason: '<img src=x onerror=alert(1)> ремонт',
    });
    const mail = sendEmailMock.mock.calls[0][0] as { html: string };
    expect(mail.html).toContain('&lt;img src=x onerror=alert(1)&gt; ремонт');
    expect(mail.html).not.toContain('<img');
    expect(mail.html).toContain('возвращать ничего не нужно');

    expect(r.telegram).toBe('sent');
    const tg = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(tg.chat_id).toBe('555');
    expect(tg.text).toContain('&lt;img');
    expect(tg.text).not.toContain('<img');
  });

  it('старая оплаченная через платформу бронь: возврат оформляет администрация', async () => {
    await notifyStayGuestStatus({ ...base, status: 'cancelled', wasPaid: true, refundAmount: 12000 });
    const mail = sendEmailMock.mock.calls[0][0] as { html: string };
    expect(mail.html).toContain('администрация платформы');
  });

  it('push — род transactional, в кабинет гостя', async () => {
    await notifyStayGuestStatus({ ...base, status: 'confirmed' });
    expect(pushMock).toHaveBeenCalledWith('guest-1', expect.objectContaining({ url: '/hub/tourist/stays' }),
      expect.objectContaining({ kind: 'transactional', type: 'stay_booking_confirmed' }));
  });

  it('сбой письма не бросает и пишется в лог без адреса гостя', async () => {
    sendEmailMock.mockRejectedValue(new Error('smtp down'));
    const r = await notifyStayGuestStatus({ ...base, status: 'confirmed' });
    expect(r.email).toBe('failed');
    const logged = errSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logged).toContain('гостю: письмо');
    expect(logged).not.toContain('guest@example.ru');
  });

  it('без user_id — некого уведомлять, в базу не ходим', async () => {
    const r = await notifyStayGuestStatus({ ...base, guestUserId: null, status: 'confirmed' });
    expect(r.email).toBe('no_address');
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('владельцу об отмене — не поручать перевод денег', () => {
  it('при оплате на месте: предоплаты не было', () => {
    const line = stayCancelMoneyLine({ wasPaid: false });
    expect(line).toMatch(/возвращать нечего/);
  });

  it('старая оплата через платформу: оформляет администрация, от владельца ничего', () => {
    const line = stayCancelMoneyLine({ wasPaid: true, refundAmount: 5000, refundPercent: 100 });
    expect(line).toMatch(/администрация платформы/);
    expect(line).not.toMatch(/CloudPayments|Переведите|переведите/);
  });
});
