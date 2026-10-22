/**
 * Сторож контроля выхода не падает молча, когда база не отвечает (22.10).
 *
 * 17, 18 и 21.10 четыре прогона `cron-checkin-watchdog` кончились пустым
 * HTTP 500 примерно через 10 секунд. Подключение к базе не выдалось ни аренде
 * окна, ни выборке регистраций (по 5 с ожидания), а выборка стояла вне
 * try: исключение уходило из обработчика, отказ в журнал прогонов не
 * писался, и для реестра кронов сторож выглядел «не запускавшимся», а не
 * упавшим. Манифест контроля выхода, правило 6: отказ проверки — отказ, а
 * не «тревог нет».
 *
 * Здесь — вызов обработчика с базой, которая отказывает: один повтор, затем
 * отказ в журнал и 503 с причиной; короткий сбой переживается повтором.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { query, recordCronRun } = vi.hoisted(() => ({ query: vi.fn(), recordCronRun: vi.fn() }));

vi.mock('@/lib/database', () => ({ query }));
vi.mock('@/lib/agents/cron-heartbeat', () => ({ recordCronRun }));
vi.mock('@/lib/agents/cron-lease', () => ({
  claimCronWindow: vi.fn(async () => 'unknown'),
  shouldRun: () => true,
  leaseSkipBody: () => ({ ok: true, status: 'lease_held' }),
}));
vi.mock('@/lib/email', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/notifications/max-channel', () => ({ maxSendDm: vi.fn() }));
vi.mock('@/lib/notifications/telegram', () => ({ telegramService: { sendMessage: vi.fn() } }));
vi.mock('@/lib/safety/trip-watch', () => ({
  alertDuty: vi.fn(), dutyStub: vi.fn(() => ''), announceClosure: vi.fn(),
}));

import { GET } from '@/app/api/cron/checkin-watchdog/route';

const POOL_TIMEOUT = Object.assign(new Error('timeout exceeded when trying to connect'), { code: undefined });
const isRead = (sql: string) => /FROM route_registrations r\b/.test(sql);
const envBefore = { ...process.env };

function call() {
  return GET(new Request('https://vedarai.ru/api/cron/checkin-watchdog', {
    headers: { authorization: 'Bearer cron-test' },
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  query.mockReset();
  recordCronRun.mockReset();
  process.env.CRON_SECRET = 'cron-test';
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env = { ...envBefore };
});

describe('сторож контроля выхода при отказе базы', () => {
  it('выборка не прочиталась и при повторе — 503 с причиной и отказ в журнале прогонов', async () => {
    query.mockImplementation(async (sql: string) => {
      if (isRead(sql)) throw POOL_TIMEOUT;
      return { rows: [] };
    });

    const pending = call();
    await vi.advanceTimersByTimeAsync(3_000);
    const res = await pending;

    expect(res.status).toBe(503);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/не проверил, кто не вернулся/);
    expect(query.mock.calls.filter(([sql]) => isRead(String(sql)))).toHaveLength(2);
    expect(recordCronRun).toHaveBeenCalledTimes(1);
    expect(recordCronRun).toHaveBeenCalledWith(
      'checkin-watchdog', expect.any(Number), 'failed',
      { error: expect.stringContaining('регистрации не прочитаны') },
    );
  });

  it('короткий сбой — повтор читает очередь, прогон обычный', async () => {
    let reads = 0;
    query.mockImplementation(async (sql: string) => {
      if (isRead(sql)) {
        reads += 1;
        if (reads === 1) throw POOL_TIMEOUT;
      }
      return { rows: [] };
    });

    const pending = call();
    await vi.advanceTimersByTimeAsync(3_000);
    const res = await pending;

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, processed: 0 });
    expect(reads).toBe(2);
    expect(recordCronRun).toHaveBeenCalledWith('checkin-watchdog', expect.any(Number), 'success', { items: 0 });
  });
});
