/**
 * Письмо туристу о брони не теряется молча (04.10, владелец: «.catch(() => {})
 * на письме — логировать ошибку, повторить через 5 мин»).
 *
 * `emailService.sendEmail` не бросает — отказ приходит `{ success: false }`,
 * поэтому `.catch` поверх него не ловил ничего. Для гостя письмо о
 * подтверждении — единственный путь к оплате.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

const { sendMock, tgMock } = vi.hoisted(() => ({ sendMock: vi.fn(), tgMock: vi.fn() }));
vi.mock('@/lib/notifications/email-service', () => ({ emailService: { sendEmail: (...a: unknown[]) => sendMock(...a) } }));
vi.mock('@/lib/notifications/tg-send', () => ({ tgSend: (...a: unknown[]) => tgMock(...a) }));

import { sendTouristMail } from '@/lib/notifications/tourist-mail';

const mail = { to: 'g@example.com', subject: 'Бронирование подтверждено: Тур', html: '<p>x</p>' };

beforeEach(() => {
  sendMock.mockReset();
  tgMock.mockReset().mockResolvedValue({ ok: true });
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('sendTouristMail', () => {
  it('ушло — sent, без повтора и тревоги', async () => {
    sendMock.mockResolvedValue({ success: true });
    expect(await sendTouristMail('t', 7, mail, 1000)).toBe('sent');
    await vi.advanceTimersByTimeAsync(2000);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(tgMock).not.toHaveBeenCalled();
  });

  it('не ушло — лог сразу, повтор через заданное время; ушло со второй — тревоги нет', async () => {
    sendMock.mockResolvedValueOnce({ success: false, error: 'SMTP 421' }).mockResolvedValueOnce({ success: true });
    expect(await sendTouristMail('t', 7, mail, 1000)).toBe('retrying');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('не ушло'), 'booking=7', 'SMTP 421');
    expect(sendMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(tgMock).not.toHaveBeenCalled();
  });

  it('не ушло дважды — тревога владельцу с номером брони', async () => {
    sendMock.mockResolvedValue({ success: false, error: 'SMTP 421' });
    await sendTouristMail('t', 7, mail, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tgMock).toHaveBeenCalledTimes(1);
    expect(String(tgMock.mock.calls[0]?.[1])).toMatch(/#7/);
  });
});

describe('двери брони не глушат письмо', () => {
  const code = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const p of ['app/api/hub/bookings/create/route.ts', 'app/api/hub/operator/bookings/[id]/route.ts']) {
    it(p, () => {
      const src = code(p);
      expect(src).toMatch(/sendTouristMail\(/);
      expect(src).not.toMatch(/emailService\.sendEmail\(/);
    });
  }
  it('кабинет оператора получает исход и показывает «не ушло»', () => {
    expect(code('app/api/hub/operator/bookings/[id]/route.ts')).toMatch(/tourist_notice: touristNotice/);
    expect(readFileSync('app/hub/operator/bookings/[id]/_BookingDetailClient.tsx', 'utf8')).toMatch(/tourist_notice === 'retrying'/);
  });
});
