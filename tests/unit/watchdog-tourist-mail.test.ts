/**
 * Watchdog называет письма туристам, которые не ушли и которые никто не закрыл
 * (#3433 п. 4, слово владельца 16.11 «Тревога надёжно»): повтор и тревога
 * жили в памяти процесса и пропали с перезапуском. Три исхода, вызовом
 * runWatchdog с подложенной базой:
 *  - открытых нет — тревоги нет;
 *  - есть — тревога tourist_mail_undelivered с номерами броней, без ПД;
 *  - база не ответила — «не смог проверить», а не «нарушений нет» (§4.0).
 * Сам запрос — на PostgreSQL (PR).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolQueryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => poolQueryMock(sql, params) },
}));
vi.mock('@/lib/agents/memory/agent-knowledge', () => ({
  knowledgeBase: { upsert: vi.fn().mockResolvedValue(undefined), appendTimeline: vi.fn().mockResolvedValue(undefined) },
}));

import { runWatchdog } from '@/lib/agents/watchdog';
import { TOURIST_MAIL_STUCK_SQL } from '@/lib/notifications/tourist-mail';

let stuck: { count: string; ids: string | null } | Error;

beforeEach(() => {
  poolQueryMock.mockReset();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  stuck = { count: '0', ids: null };
  poolQueryMock.mockImplementation((sql: string) => {
    if (sql === TOURIST_MAIL_STUCK_SQL) return stuck instanceof Error ? Promise.reject(stuck) : Promise.resolve({ rows: [stuck] });
    if (sql.includes('agent_run_history')) return Promise.resolve({ rows: [{ last_seen: new Date().toISOString() }] });
    return Promise.resolve({ rows: [] });
  });
});

describe('watchdog: письма туристам, не закрытые после перезапуска', () => {
  it('открытых нет — тревоги нет, проверка не числится отказавшей', async () => {
    const r = await runWatchdog();
    expect(poolQueryMock.mock.calls.some(([sql]) => sql === TOURIST_MAIL_STUCK_SQL)).toBe(true);
    expect(r.alerts.some((a) => a.type === 'tourist_mail_undelivered')).toBe(false);
    expect(r.checks.failed.map((f) => f.check)).not.toContain('checkUndeliveredTouristMail');
  });

  it('есть — тревога с номерами броней и что делать; без ПД', async () => {
    stuck = { count: '2', ids: '41, 57' };
    const r = await runWatchdog();
    const a = r.alerts.find((x) => x.type === 'tourist_mail_undelivered');
    expect(a).toBeTruthy();
    expect(a!.count).toBe(2);
    expect(a!.details).toMatch(/2 писем туристам о брони не ушли.*брони: 41, 57.*передайте её вручную/);
    expect(a!.details).not.toMatch(/@/);
    expect(a!.debounceOn).toBe('tourist_mail_undelivered:41, 57');
  });

  it('база не ответила — «не смог проверить», а не тишина', async () => {
    stuck = Object.assign(new Error('relation "tourist_mail_failures" does not exist'), { code: '42P01' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await runWatchdog();
    spy.mockRestore();
    expect(r.alerts.some((a) => a.type === 'tourist_mail_undelivered')).toBe(false);
    expect(r.checks.failed.map((f) => f.check)).toContain('checkUndeliveredTouristMail');
  });
});
