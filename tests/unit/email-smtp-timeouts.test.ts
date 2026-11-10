/**
 * У разговора с почтовым сервером есть срок (ревью PR 3188) — вызовом.
 *
 * У nodemailer по умолчанию две минуты на соединение и десять на молчащий
 * сокет. Письмо с данными выезда для МЧС уходит под замком выезда, то есть с
 * занятым соединением базы (lib/safety/mchs-letter): зависший почтовый сервер
 * держал бы его всё это время. Сроки задаются транспорту явно. Это сроки ШАГА,
 * а не всего письма: общего потолка на разговор они не дают.
 *
 * И отказ несёт код: по нему вызывающий отличает «сервер отказал» от «связь
 * оборвалась — ушло ли письмо, неизвестно».
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const m = vi.hoisted(() => ({ create: vi.fn(), send: vi.fn() }));
vi.mock('nodemailer', () => ({
  default: { createTransport: (...a: unknown[]) => { m.create(...a); return { sendMail: (...b: unknown[]) => m.send(...b) }; } },
}));

beforeEach(() => {
  vi.resetModules();
  m.create.mockReset();
  m.send.mockReset();
  m.send.mockResolvedValue({ messageId: 'id' });
  vi.stubEnv('SMTP_USER', 'robot');
  vi.stubEnv('SMTP_PASS', 'x');
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('сроки почтового транспорта', () => {
  it('транспорт создаётся со сроками на соединение, приветствие и молчание сокета', async () => {
    const { emailService, SMTP_TIMEOUTS } = await import('@/lib/notifications/email-service');
    const r = await emailService.sendEmail({ to: 'x@vedarai.ru', subject: 'Проба', html: '<p>Проба</p>' });
    expect(r.success).toBe(true);
    expect(m.create).toHaveBeenCalledTimes(1);
    const opts = m.create.mock.calls[0]![0] as Record<string, unknown>;
    for (const key of ['dnsTimeout', 'connectionTimeout', 'greetingTimeout', 'socketTimeout'] as const) {
      expect(opts[key], key).toBe(SMTP_TIMEOUTS[key]);
      expect(Number(opts[key]), key).toBeGreaterThan(0);
      // Ни один шаг не ждёт дольше минуты: зависший сервер отпускает соединение базы вызывающего.
      expect(Number(opts[key]), key).toBeLessThanOrEqual(60_000);
    }
    // Молчание сокета — не короче полуминуты: сервер, принявший тело письма, думает
    // над ответом, и ранний обрыв дал бы «не ушло» при письме, которое ушло.
    expect(SMTP_TIMEOUTS.socketTimeout).toBeGreaterThanOrEqual(30_000);
  });

  it('отказ несёт код nodemailer — обрыв связи отличим от отказа сервера', async () => {
    const { emailService } = await import('@/lib/notifications/email-service');
    m.send.mockRejectedValueOnce(Object.assign(new Error('Timeout'), { code: 'ETIMEDOUT' }));
    expect(await emailService.sendEmail({ to: 'x@vedarai.ru', subject: 'Проба', html: '<p>Проба</p>' }))
      .toEqual({ success: false, error: 'Timeout', code: 'ETIMEDOUT' });
    m.send.mockRejectedValueOnce(new Error('554 rejected'));
    expect(await emailService.sendEmail({ to: 'x@vedarai.ru', subject: 'Проба', html: '<p>Проба</p>' }))
      .toEqual({ success: false, error: '554 rejected' });
  });

  it('почта не настроена — транспорт не создаётся вовсе, исход назван', async () => {
    vi.stubEnv('SMTP_PASS', '');
    const { emailService } = await import('@/lib/notifications/email-service');
    const r = await emailService.sendEmail({ to: 'x@vedarai.ru', subject: 'Проба', html: '<p>Проба</p>' });
    expect(r).toEqual({ success: false, error: 'Email service not configured' });
    expect(m.create).not.toHaveBeenCalled();
  });
});
