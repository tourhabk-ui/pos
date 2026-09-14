/**
 * tests/unit/booking-notify-access-link.test.ts
 *
 * #1889: ключ доступа к брони уходил только письмом — в Telegram-уведомление
 * «Бронирование принято!» он не попадал вовсе, хотя notifyTouristBookingCreated
 * зовётся для каждого авторизованного туриста с привязанным Telegram. Ссылка
 * «Перейти к оплате» теперь появляется, когда accessToken передан.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMessageMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/notifications/telegram', () => ({
  telegramService: { sendMessage: (...args: unknown[]) => sendMessageMock(...args) },
}));

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

import { notifyTouristBookingCreated } from '@/lib/telegram/booking-notify';

const BASE_BOOKING = {
  id: '42',
  tourTitle: 'Восхождение на Авачинский',
  date: new Date('2099-01-01'),
  participants: 2,
  totalAmount: 10000,
};

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockResolvedValue({ rows: [{ telegram_id: '555' }] });
});

describe('notifyTouristBookingCreated — ссылка на оплату в сообщении', () => {
  it('accessToken передан — сообщение несёт рабочую ссылку на booking-success', async () => {
    notifyTouristBookingCreated('user-1', { ...BASE_BOOKING, accessToken: 'tok-abc' });
    await vi.waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));

    const [{ text }] = sendMessageMock.mock.calls[0]!;
    expect(text).toContain('Перейти к оплате');
    expect(text).toContain('/booking-success/42?t=tok-abc');
  });

  it('accessToken не передан — старые вызывающие места не ломаются, ссылки на оплату просто нет', async () => {
    notifyTouristBookingCreated('user-1', BASE_BOOKING);
    await vi.waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));

    const [{ text }] = sendMessageMock.mock.calls[0]!;
    expect(text).not.toContain('Перейти к оплате');
    expect(text).toContain('Мои бронирования');
  });

  it('токен со спецсимволами кодируется в URL', async () => {
    notifyTouristBookingCreated('user-1', { ...BASE_BOOKING, accessToken: 'a+b/c=' });
    await vi.waitFor(() => expect(sendMessageMock).toHaveBeenCalledTimes(1));

    const [{ text }] = sendMessageMock.mock.calls[0]!;
    expect(text).toContain(`?t=${encodeURIComponent('a+b/c=')}`);
  });
});
