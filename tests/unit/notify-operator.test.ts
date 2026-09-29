/**
 * Общий хвост «оператору — о новой брони»: U-ON и мессенджер (обзор ветки
 * 29.09). Раньше он жил внутри веб-формы, и запрос мест, подтвердивший бронь
 * кнопкой, не звал его вовсе: оператор не знал, кому звонить.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const poolQueryMock = vi.hoisted(() => vi.fn());
const reachMock = vi.hoisted(() => vi.fn());
const notifyMock = vi.hoisted(() => vi.fn());
const uonMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQueryMock(...a) } }));
vi.mock('@/lib/partners/reach', () => ({ reachForPartner: (id: string) => reachMock(id) }));
vi.mock('@/lib/notifications/operator-booking', () => ({ notifyNewBooking: (p: unknown) => notifyMock(p) }));
vi.mock('@/lib/integrations/uon', () => ({ createUonRequest: (...a: unknown[]) => uonMock(...a) }));

import { notifyOperatorOfNewBooking } from '@/lib/bookings/notify-operator';

const b = {
  bookingId: 42, operatorId: 'op', tourTitle: 'Тур', date: '2099-07-10', participants: 2, totalPrice: 9000,
  touristName: 'Иван', touristPhone: '+79000000000', via: 'seat_request',
};

beforeEach(() => {
  for (const m of [poolQueryMock, reachMock, notifyMock, uonMock]) m.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  poolQueryMock.mockResolvedValue({ rows: [{ name: 'Оп', uon_api_key: null, phone: '+7', email: 'a@b.c' }] });
  reachMock.mockResolvedValue({ reachable: true, maxChatId: '1', telegramChatId: '2' });
  notifyMock.mockResolvedValue({ state: 'delivered', channel: 'max' });
});

describe('notifyOperatorOfNewBooking', () => {
  it('шлёт уведомление с контактами туриста и адресами оператора; источник назван', async () => {
    const r = await notifyOperatorOfNewBooking(b);
    expect(r).toEqual({ state: 'notified', outcome: { state: 'delivered', channel: 'max' } });
    expect(notifyMock.mock.calls[0]![0]).toMatchObject({
      booking_id: '42', tourist_name: 'Иван', tourist_phone: '+79000000000',
      operator_max_chat_id: '1', operator_telegram_chat_id: '2', operator_phone: '+7', via: 'seat_request',
    });
    expect(uonMock).not.toHaveBeenCalled();
  });

  it('у оператора U-ON: заявка уходит в его CRM и id сохраняется в брони', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ name: 'Оп', uon_api_key: 'k', phone: null, email: null }] });
    uonMock.mockResolvedValue(777);
    await notifyOperatorOfNewBooking(b);
    expect(uonMock).toHaveBeenCalledWith('k', expect.objectContaining({ booking_id: '42', tourist_phone: '+79000000000' }));
    const upd = poolQueryMock.mock.calls.find(([sql]) => /SET uon_request_id/.test(String(sql)))!;
    expect(upd[1]).toEqual([777, 42]);
  });

  it('падение U-ON не отменяет уведомление в мессенджер', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [{ name: 'Оп', uon_api_key: 'k', phone: null, email: null }] });
    uonMock.mockRejectedValue(new Error('crm down'));
    const r = await notifyOperatorOfNewBooking(b);
    expect(r.state).toBe('notified');
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it('любой сбой — исход «не смог» с причиной, а не исключение и не тишина', async () => {
    reachMock.mockRejectedValue(new Error('db down'));
    expect(await notifyOperatorOfNewBooking(b)).toEqual({ state: 'failed', reason: 'db down' });
  });

  it('у оператора нет канала — исход no_channel отдаётся вызывающему как есть', async () => {
    reachMock.mockResolvedValue({ reachable: false, maxChatId: null, telegramChatId: null });
    notifyMock.mockResolvedValue({ state: 'no_channel' });
    expect(await notifyOperatorOfNewBooking(b)).toEqual({ state: 'notified', outcome: { state: 'no_channel' } });
  });
});
