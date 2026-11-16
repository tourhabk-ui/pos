/**
 * После старта сервер подбирает сообщения Telegram, брошенные прежним
 * запуском (#3433 п. 1, слово владельца 16.11 «Оба шага»): Telegram получил 200
 * до обработки и сам не повторит. Вызовом lib/chat/recover-on-start с
 * подменённым http.request и таймером; instrumentation — вызовом register().
 * Сам подбор (GET вебхука) — в telegram-webhook-kuzmich-brain.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { scheduleTelegramRecovery, RECOVER_AFTER_MS, RECOVER_PATH } from '@/lib/chat/recover-on-start';
import { INBOUND_CLAIM_MIN_AGE_SECONDS } from '@/lib/chat/inbound-seen';

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined); });
afterEach(() => { errorLog.mockRestore(); vi.unstubAllEnvs(); });

/** Подменный http.request: запоминает опции и отвечает заданным кодом и телом. */
function fakeRequest(status: number, body: string) {
  const calls: http.RequestOptions[] = [];
  const request = ((options: http.RequestOptions, cb: (res: http.IncomingMessage) => void) => {
    calls.push(options);
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    req.destroy = () => undefined;
    req.end = () => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number; setEncoding: () => void };
      res.statusCode = status;
      res.setEncoding = () => undefined;
      cb(res as unknown as http.IncomingMessage);
      res.emit('data', body);
      res.emit('end');
    };
    return req;
  }) as unknown as typeof http.request;
  return { calls, request };
}

const logged = () => errorLog.mock.calls.map((c) => String(c[0])).join('\n');

describe('scheduleTelegramRecovery', () => {
  it('через 150 с зовёт свой сервер: GET вебхука с CRON_SECRET, Host 127.0.0.1', () => {
    const { calls, request } = fakeRequest(200, '{"ok":true,"recovered":2}');
    const timers: Array<[() => void, number]> = [];
    const out = scheduleTelegramRecovery({
      env: { NODE_ENV: 'production', CRON_SECRET: 's3', PORT: '3001' } as NodeJS.ProcessEnv,
      request, schedule: (fn, ms) => timers.push([fn, ms]),
    });
    expect(out).toBe('scheduled');
    expect(timers).toHaveLength(1);
    expect(timers[0][1]).toBe(RECOVER_AFTER_MS);
    // Позже порога возраста подбора: брошенное перед падением к этому времени старше двух минут.
    expect(RECOVER_AFTER_MS / 1000).toBeGreaterThan(INBOUND_CLAIM_MIN_AGE_SECONDS);
    expect(calls).toHaveLength(0); // до таймера — ничего

    timers[0][0]();
    expect(calls[0]).toMatchObject({
      hostname: '127.0.0.1', port: 3001, path: RECOVER_PATH, method: 'GET',
      headers: { host: '127.0.0.1:3001', authorization: 'Bearer s3' },
    });
    expect(RECOVER_PATH).toBe('/api/telegram/webhook');
    expect(logged()).toContain('подобрано сообщений Telegram: 2');
  });

  it('ответ не 200 — в лог с кодом, а не тишина', () => {
    const { request } = fakeRequest(503, '{"ok":false}');
    let fire: () => void = () => undefined;
    scheduleTelegramRecovery({
      env: { NODE_ENV: 'production', CRON_SECRET: 's3' } as NodeJS.ProcessEnv,
      request, schedule: (fn) => { fire = fn; },
    });
    fire();
    expect(logged()).toContain('HTTP 503');
  });

  it('без CRON_SECRET — не планирует и говорит почему; вне production — молча не планирует', () => {
    const schedule = vi.fn();
    expect(scheduleTelegramRecovery({ env: { NODE_ENV: 'production' } as NodeJS.ProcessEnv, schedule })).toBe('skipped');
    expect(logged()).toMatch(/CRON_SECRET не задан/);
    expect(scheduleTelegramRecovery({ env: { NODE_ENV: 'development', CRON_SECRET: 's' } as NodeJS.ProcessEnv, schedule })).toBe('skipped');
    expect(schedule).not.toHaveBeenCalled();
  });
});

describe('instrumentation: старт планирует подбор', () => {
  const schedule = vi.fn();
  beforeEach(() => {
    vi.resetModules();
    schedule.mockReset();
    vi.doMock('@/lib/chat/recover-on-start', () => ({ scheduleTelegramRecovery: schedule }));
    vi.doMock('@/lib/config', () => ({ validateConfig: () => ({ warnings: [], fatal: [] }) }));
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('MAX_BOT_TOKEN', '');
    vi.spyOn(process, 'on').mockImplementation(() => process);
  });
  afterEach(() => {
    vi.doUnmock('@/lib/chat/recover-on-start');
    vi.doUnmock('@/lib/config');
  });

  it('register() зовёт scheduleTelegramRecovery', async () => {
    const { register } = await import('@/instrumentation');
    await register();
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(1));
  });
});
