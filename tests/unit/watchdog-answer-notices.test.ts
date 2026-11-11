/**
 * tests/unit/watchdog-answer-notices.test.ts
 *
 * Watchdog называет застрявшие сообщения после ответа оператора (план «после
 * отказа», 2б, answer_notices 1424; ревью 2б: «проверка сторожа пустая»).
 * Три исхода проверки, вызовом runWatchdog с подложенной базой:
 *  - застрявших нет — тревоги нет;
 *  - есть — тревога answer_notice_stuck: «не дошло — позвонить» и «дошло, а
 *    „звонить не нужно“ не ушло — не звонить» разными словами, без ПД;
 *  - база не ответила — «не смог проверить», а не «нарушений нет» (§4.0).
 * Что считается застрявшим — сам SQL на настоящем PostgreSQL:
 * tests/integration/request-chat.pg.test.ts.
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
import { NOTICE_STUCK_SQL } from '@/lib/requests/answer-notice';

let stuck: { count: string; ids: string | null; uncleared: string; uncleared_ids: string | null } | Error;

beforeEach(() => {
  poolQueryMock.mockReset();
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  stuck = { count: '0', ids: null, uncleared: '0', uncleared_ids: null };
  poolQueryMock.mockImplementation((sql: string) => {
    if (sql === NOTICE_STUCK_SQL) return stuck instanceof Error ? Promise.reject(stuck) : Promise.resolve({ rows: [stuck] });
    if (sql.includes('agent_run_history')) return Promise.resolve({ rows: [{ last_seen: new Date().toISOString() }] });
    return Promise.resolve({ rows: [] });
  });
});

describe('watchdog: застрявшие сообщения после ответа оператора', () => {
  it('застрявших нет — тревоги нет, проверка не числится отказавшей', async () => {
    const r = await runWatchdog();
    expect(poolQueryMock.mock.calls.some(([sql]) => sql === NOTICE_STUCK_SQL)).toBe(true);
    expect(r.alerts.some((a) => a.type === 'answer_notice_stuck')).toBe(false);
    expect(r.checks.failed.map((f) => f.check)).not.toContain('checkStuckAnswerNotices');
  });

  it('не дошло и менеджер не знает — «позвонить»; дошло без «звонить не нужно» — «не звонить»; номера, без ПД', async () => {
    stuck = { count: '2', ids: '0f1e2d3c,1a2b3c4d', uncleared: '1', uncleared_ids: '9e8d7c6b' };
    const r = await runWatchdog();
    const a = r.alerts.find((x) => x.type === 'answer_notice_stuck');
    expect(a).toBeTruthy();
    expect(a!.count).toBe(3);
    expect(a!.details).toMatch(/2 ответов оператора не дошли до туриста.*0f1e2d3c,1a2b3c4d.*позвонить/);
    expect(a!.details).toMatch(/1 ответов дошли до туриста уже после письма менеджеру.*9e8d7c6b.*звонить не нужно/);

    // Только «звонить не нужно» — слова «позвонить по ним» нет.
    stuck = { count: '0', ids: null, uncleared: '1', uncleared_ids: '9e8d7c6b' };
    const only = (await runWatchdog()).alerts.find((x) => x.type === 'answer_notice_stuck');
    expect(only!.count).toBe(1);
    expect(only!.details).not.toMatch(/позвонить по ним/);
  });

  it('база не ответила — «не смог проверить», а не тишина', async () => {
    stuck = Object.assign(new Error('relation "answer_notices" does not exist'), { code: '42P01' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await runWatchdog();
    spy.mockRestore();
    expect(r.alerts.some((a) => a.type === 'answer_notice_stuck')).toBe(false);
    expect(r.checks.failed.map((f) => f.check)).toContain('checkStuckAnswerNotices');
  });
});
