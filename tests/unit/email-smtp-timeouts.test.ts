/**
 * У разговора с почтовым сервером есть срок (ревью PR 3188) — вызовом.
 *
 * У nodemailer по умолчанию две минуты на соединение и десять на молчащий
 * сокет. Письмо с данными выезда для МЧС уходит под замком выезда, то есть с
 * занятым соединением базы (lib/safety/mchs-letter): зависший почтовый сервер
 * держал бы его всё это время. Сроки задаются транспорту явно, и сумма их —
 * не дольше минуты с небольшим.
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
    for (const key of ['connectionTimeout', 'greetingTimeout', 'socketTimeout'] as const) {
      expect(opts[key], key).toBe(SMTP_TIMEOUTS[key]);
      expect(Number(opts[key]), key).toBeGreaterThan(0);
    }
    // Зависший сервер не держит вызывающего (и его соединение базы) дольше минуты с небольшим.
    expect(SMTP_TIMEOUTS.connectionTimeout + SMTP_TIMEOUTS.greetingTimeout + SMTP_TIMEOUTS.socketTimeout).toBeLessThanOrEqual(75_000);
  });

  it('почта не настроена — транспорт не создаётся вовсе, исход назван', async () => {
    vi.stubEnv('SMTP_PASS', '');
    const { emailService } = await import('@/lib/notifications/email-service');
    const r = await emailService.sendEmail({ to: 'x@vedarai.ru', subject: 'Проба', html: '<p>Проба</p>' });
    expect(r).toEqual({ success: false, error: 'Email service not configured' });
    expect(m.create).not.toHaveBeenCalled();
  });
});
