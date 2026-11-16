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

const { sendMock, tgMock, db } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  tgMock: vi.fn(),
  /** tourist_mail_failures в памяти теста (1450). */
  db: { rows: [] as Array<{ id: string; booking_id: string; scope: string; resolution: string | null }>, fail: false },
}));
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: async (sql: string, params: unknown[] = []) => {
      if (db.fail) throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
      if (sql.startsWith('INSERT INTO tourist_mail_failures')) {
        const id = String(db.rows.length + 1);
        db.rows.push({ id, booking_id: String(params[0]), scope: String(params[1]), resolution: null });
        return { rows: [{ id }] };
      }
      if (sql.startsWith('UPDATE tourist_mail_failures')) {
        const row = db.rows.find((r) => r.id === params[0] && r.resolution === null);
        if (row) row.resolution = String(params[1]);
        return { rows: [], rowCount: row ? 1 : 0 };
      }
      throw new Error(`неожиданный запрос: ${sql}`);
    },
  },
}));
vi.mock('@/lib/notifications/email-service', () => ({ emailService: { sendEmail: (...a: unknown[]) => sendMock(...a) } }));
vi.mock('@/lib/notifications/tg-send', () => ({ tgSend: (...a: unknown[]) => tgMock(...a) }));

import { sendTouristMail } from '@/lib/notifications/tourist-mail';

const mail = { to: 'g@example.com', subject: 'Бронирование подтверждено: Тур', html: '<p>x</p>' };

beforeEach(() => {
  db.rows = [];
  db.fail = false;
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

  // Аудит 15.10, Д4-5: отказ SMTP называет получателя, и адрес туриста уходил
  // сырым в Telegram владельца и в лог. Для разбора хватает номера брони.
  it('адрес туриста из текста отказа SMTP не уходит ни в Telegram, ни в лог', async () => {
    sendMock
      .mockResolvedValueOnce({ success: false, error: '550 <a@b.ru>: Recipient address rejected' })
      .mockRejectedValueOnce(new Error('550 5.1.1 <ivan.sidorov@mail.ru> user unknown, тел. +7 914 123-45-67'));
    await sendTouristMail('t', 7, mail, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tgMock).toHaveBeenCalledTimes(1);
    const alert = String(tgMock.mock.calls[0]?.[1]);
    expect(alert).not.toContain('@');
    expect(alert).not.toContain('914 123');
    expect(alert).toMatch(/550 5\.1\.1/);
    expect(alert).toContain('[email]');
    const logged = vi.mocked(console.error).mock.calls.flat().map(String).join('\n');
    expect(logged).not.toContain('@');
    expect(logged).toContain('booking=7');
  });
});

describe('двери брони не глушат письмо', () => {
  const code = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const p of ['app/api/hub/bookings/create/route.ts', 'lib/bookings/owner-status.ts']) {
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

// #3433 п. 4, слово владельца 16.11 «Тревога надёжно»: повтор и тревога живут
// в памяти, поэтому факт недоставки — в базе. Его закрывает дошедший повтор
// или дошедшая тревога; не закрытый к сроку называет Watchdog
// (tests/unit/watchdog-tourist-mail.test.ts).
describe('факт недоставки письма — в базе, без ПД', () => {
  it('не ушло — строка с номером брони и областью, без адреса и темы', async () => {
    sendMock.mockResolvedValue({ success: false, error: 'SMTP 421' });
    await sendTouristMail('bookings/create', 7, mail, 1000);
    expect(db.rows).toEqual([{ id: '1', booking_id: '7', scope: 'bookings/create', resolution: null }]);
    expect(JSON.stringify(db.rows)).not.toContain('g@example.com');
    expect(JSON.stringify(db.rows)).not.toContain('Бронирование подтверждено');
  });

  it('ушло со второй попытки — строка закрыта «sent»', async () => {
    sendMock.mockResolvedValueOnce({ success: false, error: 'SMTP 421' }).mockResolvedValueOnce({ success: true });
    await sendTouristMail('t', 7, mail, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(db.rows[0].resolution).toBe('sent');
  });

  it('не ушло дважды, тревога дошла — «alerted»; тревога не дошла — строка открыта для Watchdog', async () => {
    sendMock.mockResolvedValue({ success: false, error: 'SMTP 421' });
    await sendTouristMail('t', 7, mail, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(db.rows[0].resolution).toBe('alerted');

    tgMock.mockResolvedValue({ ok: false, reason: 'нет сети' });
    await sendTouristMail('t', 8, mail, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(db.rows[1]).toMatchObject({ booking_id: '8', resolution: null });
  });

  it('процесс перезапустился до повтора — строка остаётся открытой', async () => {
    sendMock.mockResolvedValue({ success: false, error: 'SMTP 421' });
    await sendTouristMail('t', 9, mail, 1000);
    vi.clearAllTimers(); // таймер повтора пропал вместе с процессом
    expect(db.rows[0]).toMatchObject({ booking_id: '9', resolution: null });
  });

  it('база не ответила — повтор в памяти идёт как раньше, отказ в логе', async () => {
    db.fail = true;
    sendMock.mockResolvedValueOnce({ success: false, error: 'SMTP 421' }).mockResolvedValueOnce({ success: true });
    expect(await sendTouristMail('t', 7, mail, 1000)).toBe('retrying');
    expect(vi.mocked(console.error).mock.calls.some((c) => String(c[0]).includes('факт недоставки письма не записан (ECONNREFUSED)'))).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});
