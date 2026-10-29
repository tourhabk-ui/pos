/**
 * Уведомление о новой брони (lib/notifications/operator-booking.ts) — копия
 * менеджерам команды кабинета (CRM 2г-4). Проверяется вызовом
 * `notifyNewBooking`, а не строкой в модуле (CLAUDE.md §4, решение 13.10).
 *
 * Что держит:
 *  - кабинет назван — команде уходит тот же текст, что оператору, с той же
 *    ссылкой; кабинет не назван — команде ничего;
 *  - задача администратору «нет канала» говорит правду о команде: заголовок
 *    «дошла только до менеджеров» — лишь когда контакты туриста дошли до
 *    менеджера в MAX; заглушка в Telegram и «команду не прочитать» этого
 *    заголовка не дают.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { pdMock, teamMock } = vi.hoisted(() => ({ pdMock: vi.fn(), teamMock: vi.fn() }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: (...a: unknown[]) => pdMock(...a) }));
vi.mock('@/lib/operators/team-notify', () => ({ notifyTeam: (...a: unknown[]) => teamMock(...a) }));
vi.mock('@/lib/config', () => ({ getPublicBaseUrl: () => 'https://vedarai.ru' }));

import { notifyNewBooking } from '@/lib/notifications/operator-booking';

const BOOKING = {
  booking_id: '77', tour_title: 'Авачинский', tourist_name: 'Анна Петрова', tourist_phone: '+79990001122',
  booking_date: '2099-07-01', participants: 2, final_price: 24000, operator_name: 'Вулкан Тур', via: 'website',
};
const LINK = { text: 'Открыть бронь', url: 'https://vedarai.ru/hub/operator/bookings/77' };
type Sent = { text: string; stub: string; buttons?: unknown; to?: unknown };
const sent = () => pdMock.mock.calls.map(c => c[0] as Sent);

beforeEach(() => {
  pdMock.mockReset();
  teamMock.mockReset();
  pdMock.mockResolvedValue({ channel: 'max', delivered: true, reason: 'ok' });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('копия брони команде кабинета', () => {
  it('кабинет назван — команде тот же текст, что оператору, и та же ссылка', async () => {
    teamMock.mockResolvedValue({ state: 'sent', members: 1, delivered: 1, stubbed: 0 });
    expect(await notifyNewBooking({ ...BOOKING, operator_partner_id: 'cab-1', operator_max_chat_id: '900' }))
      .toEqual({ state: 'delivered', channel: 'max' });
    expect(teamMock).toHaveBeenCalledTimes(1);
    const [cabinet, msg, what] = teamMock.mock.calls[0] as [string, Sent, string];
    expect(cabinet).toBe('cab-1');
    expect(what).toBe('бронь #77');
    const toOperator = sent().find(s => s.to)!;
    expect(msg.text).toBe(toOperator.text);
    expect(msg.text).toContain('Анна Петрова');
    expect(msg.stub).not.toContain('Анна Петрова');
    expect(msg.stub).not.toContain('+79990001122');
    expect(msg.buttons).toEqual([LINK]);
  });

  it('кабинет не назван — команде ничего', async () => {
    await notifyNewBooking({ ...BOOKING, operator_max_chat_id: '900' });
    expect(teamMock).not.toHaveBeenCalled();
  });
});

describe('продавец тура — гид (28.10)', () => {
  it('личное сообщение гиду ведёт в «Свои туры»; копия рабочему чату — прежней ссылкой', async () => {
    expect(await notifyNewBooking({ ...BOOKING, operator_max_chat_id: '900', operator_category: 'guide' }))
      .toEqual({ state: 'delivered', channel: 'max' });
    const toGuide = sent().find(s => s.to)!;
    expect(toGuide.buttons).toEqual([{ text: 'Открыть бронь', url: 'https://vedarai.ru/hub/guide/own' }]);
    const toAdmin = sent().find(s => !s.to)!;
    expect(toAdmin.buttons).toEqual([LINK]);
  });

  it('оператору и без категории — бронь в кабинете оператора', async () => {
    for (const operator_category of ['operator', null, undefined]) {
      pdMock.mockClear();
      await notifyNewBooking({ ...BOOKING, operator_max_chat_id: '900', operator_category });
      expect(sent().find(s => s.to)!.buttons).toEqual([LINK]);
    }
  });
});

describe('задача администратору «нет канала» знает про команду', () => {
  const handoff = () => sent().find(s => /нет канала|нет своего канала/.test(s.text))!.text;

  it('контакты дошли до менеджера в MAX — так и сказано, с числом', async () => {
    teamMock.mockResolvedValue({ state: 'sent', members: 2, delivered: 1, stubbed: 1 });
    expect(await notifyNewBooking({ ...BOOKING, operator_partner_id: 'cab-1' })).toEqual({ state: 'no_channel' });
    expect(handoff()).toMatch(/бронь с контактами туриста дошла только до менеджеров команды \(1\)/);
  });

  it('только заглушка в Telegram или команду не прочитать — задача прежняя', async () => {
    for (const team of [{ state: 'sent', members: 1, delivered: 0, stubbed: 1 }, { state: 'unknown' }]) {
      pdMock.mockClear();
      teamMock.mockResolvedValue(team);
      expect(await notifyNewBooking({ ...BOOKING, operator_partner_id: 'cab-1' })).toEqual({ state: 'no_channel' });
      expect(handoff()).toMatch(/Заявка не дойдёт до оператора — нет канала/);
      expect(handoff()).not.toMatch(/дошла только до менеджеров/);
    }
  });
});
