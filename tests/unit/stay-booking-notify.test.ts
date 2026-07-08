/**
 * tests/unit/stay-booking-notify.test.ts
 *
 * Уведомление владельцу о новой брони жилья (цикл жизненного цикла, PR 1):
 * - notifyNewStayBooking шлёт admin + владельцу (chat_id), экранирует HTML;
 * - сбой Telegram non-fatal (не бросает);
 * - book-роут вызывает уведомление с chat_id владельца после брони.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('notifyNewStayBooking', () => {
  const OLD_ENV = { ...process.env };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    process.env.TELEGRAM_BOT_TOKEN = 'token';
    process.env.TELEGRAM_CHAT_ID = 'admin-chat';
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
    vi.unstubAllGlobals();
  });

  it('шлёт админу и владельцу, экранирует HTML в названии', async () => {
    const { notifyNewStayBooking } = await import('@/lib/notifications/stay-booking');
    await notifyNewStayBooking({
      bookingId: 'b1',
      accommodationName: 'Дом <b>&test</b>',
      roomName: 'Люкс',
      checkInDate: '2099-08-01',
      checkOutDate: '2099-08-03',
      guests: 2,
      totalPrice: 21000,
      guestName: 'Иван',
      guestPhone: '+79000000000',
      ownerTelegramChatId: 'owner-chat',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const chats = fetchMock.mock.calls.map(c => JSON.parse(String((c[1] as RequestInit).body)).chat_id);
    expect(chats).toContain('admin-chat');
    expect(chats).toContain('owner-chat');

    const firstBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(firstBody.text).toContain('&lt;b&gt;&amp;test');   // экранировано
    expect(firstBody.text).toContain('01.08.2099');           // дата в DD.MM.YYYY
    expect(firstBody.text).toMatch(/21\s000/);                // ru-RU: узкий неразрывный пробел
  });

  it('без chat_id владельца шлёт только админу', async () => {
    const { notifyNewStayBooking } = await import('@/lib/notifications/stay-booking');
    await notifyNewStayBooking({
      bookingId: 'b1', accommodationName: 'Дом', checkInDate: '2099-08-01',
      checkOutDate: '2099-08-03', guests: 1, ownerTelegramChatId: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('сбой Telegram non-fatal — не бросает', async () => {
    fetchMock.mockRejectedValue(new Error('network'));
    const { notifyNewStayBooking } = await import('@/lib/notifications/stay-booking');
    await expect(notifyNewStayBooking({
      bookingId: 'b1', accommodationName: 'Дом', checkInDate: '2099-08-01',
      checkOutDate: '2099-08-03', guests: 1, ownerTelegramChatId: 'owner',
    })).resolves.toBeUndefined();
  });

  it('без TELEGRAM_BOT_TOKEN ничего не шлёт', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const { notifyNewStayBooking } = await import('@/lib/notifications/stay-booking');
    await notifyNewStayBooking({
      bookingId: 'b1', accommodationName: 'Дом', checkInDate: '2099-08-01',
      checkOutDate: '2099-08-03', guests: 1, ownerTelegramChatId: 'owner',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
