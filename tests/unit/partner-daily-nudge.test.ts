/**
 * Напоминание партнёру от Watchdog — не чаще раза в сутки и не ночью (#3433
 * п. 6, слово владельца 16.11 «Раз в сутки»). Вызовом lib/partners/daily-nudge
 * на таблице в памяти теста и прогонами runWatchdog; SQL замка — на
 * PostgreSQL в tests/integration/chat-cabinet.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { poolQueryMock, noticeMock } = vi.hoisted(() => ({
  poolQueryMock: vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>(),
  noticeMock: vi.fn(),
}));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => poolQueryMock(sql, params) },
}));
vi.mock('@/lib/partners/notice', () => ({ sendPartnerNotice: noticeMock }));
vi.mock('@/lib/agents/memory/agent-knowledge', () => ({
  knowledgeBase: {
    upsert: vi.fn().mockResolvedValue(undefined),
    appendTimeline: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('@/lib/mcp/catalogs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mcp/catalogs')>()),
  MCP_SILENCE_ALERT_FROM_DAYS: Number.POSITIVE_INFINITY,
}));

import { nudgePartnerOncePerDay, nudgeSummary, NUDGE_KEEP_DAYS } from '@/lib/partners/daily-nudge';
import { runWatchdog } from '@/lib/agents/watchdog';

/** partner_nudges в памяти: ключ партнёр|вид|сутки. */
const nudges = new Map<string, { id: string; status: string }>();
let seq = 0;
function nudgeTable(sql: string, p: unknown[] = []): { rows: unknown[] } | null {
  if (sql.includes('INSERT INTO partner_nudges')) {
    const key = `${p[0]}|${p[1]}|${p[2]}`;
    if (nudges.has(key)) return { rows: [] };
    const id = `n${++seq}`;
    nudges.set(key, { id, status: 'sending' });
    return { rows: [{ id }] };
  }
  if (sql.includes('UPDATE partner_nudges')) {
    for (const v of nudges.values()) if (v.id === p[0] && v.status === 'sending') v.status = String(p[1]);
    return { rows: [] };
  }
  if (sql.includes('DELETE FROM partner_nudges WHERE id')) {
    for (const [k, v] of nudges) if (v.id === p[0] && v.status === 'sending') nudges.delete(k);
    return { rows: [] };
  }
  if (sql.includes('DELETE FROM partner_nudges WHERE day')) return { rows: [] };
  return null;
}

const DAY = new Date('2026-11-16T02:00:00Z');    // 14:00 по Камчатке
const NIGHT = new Date('2026-11-16T12:00:00Z');  // 00:00 по Камчатке

beforeEach(() => {
  nudges.clear();
  poolQueryMock.mockReset();
  poolQueryMock.mockImplementation((sql: string, p?: unknown[]) => {
    const r = nudgeTable(sql, p);
    if (r) return Promise.resolve(r);
    throw new Error(`неожиданный запрос: ${sql}`);
  });
  noticeMock.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('nudgePartnerOncePerDay', () => {
  it('днём — уходит один раз; второй прогон тех же суток молчит', async () => {
    const send = vi.fn().mockResolvedValue('max');
    expect(await nudgePartnerOncePerDay('p1', 'operator_booking', send, DAY)).toEqual({ status: 'sent', channel: 'max' });
    expect(await nudgePartnerOncePerDay('p1', 'operator_booking', send, DAY)).toEqual({ status: 'already_today' });
    expect(send).toHaveBeenCalledTimes(1);
    expect([...nudges.values()]).toEqual([{ id: 'n1', status: 'max' }]);
  });

  it('другой вид и другой партнёр — свой замок; следующие сутки — снова можно', async () => {
    const send = vi.fn().mockResolvedValue('telegram');
    await nudgePartnerOncePerDay('p1', 'operator_booking', send, DAY);
    await nudgePartnerOncePerDay('p1', 'stay_booking', send, DAY);
    await nudgePartnerOncePerDay('p2', 'operator_booking', send, DAY);
    await nudgePartnerOncePerDay('p1', 'operator_booking', send, new Date('2026-11-16T21:00:00Z')); // 09:00 17.11
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('ночь по Камчатке (22–08) — не шлём и в базу не ходим', async () => {
    const send = vi.fn().mockResolvedValue('max');
    expect(await nudgePartnerOncePerDay('p1', 'gear_rental', send, NIGHT)).toEqual({ status: 'quiet' });
    expect(send).not.toHaveBeenCalled();
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('не доставлено — замок снят, следующий прогон пробует снова', async () => {
    const send = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('max');
    expect(await nudgePartnerOncePerDay('p1', 'transfer_seat', send, DAY)).toEqual({ status: 'undelivered' });
    expect(nudges.size).toBe(0);
    expect(await nudgePartnerOncePerDay('p1', 'transfer_seat', send, DAY)).toEqual({ status: 'sent', channel: 'max' });
  });

  it('отправка бросила — тоже недоставка, замок снят', async () => {
    const send = vi.fn().mockRejectedValue(new Error('сеть'));
    expect(await nudgePartnerOncePerDay('p1', 'stay_booking', send, DAY)).toEqual({ status: 'undelivered' });
    expect(nudges.size).toBe(0);
  });

  it('журнал не ответил — не шлём (лучше пропуск, чем повтор каждые полчаса), причина в логе', async () => {
    poolQueryMock.mockRejectedValueOnce(Object.assign(new Error('down'), { code: '57P01' }));
    const send = vi.fn().mockResolvedValue('max');
    expect(await nudgePartnerOncePerDay('p1', 'operator_booking', send, DAY)).toEqual({ status: 'unknown' });
    expect(send).not.toHaveBeenCalled();
    expect(String(vi.mocked(console.error).mock.calls[0][0])).toMatch(/\[partner-nudge\].*57P01/);
  });

  it('без id партнёра — не шлём: помнить отправку не по чему', async () => {
    const send = vi.fn().mockResolvedValue('max');
    expect(await nudgePartnerOncePerDay(null, 'stay_booking', send, DAY)).toEqual({ status: 'unknown' });
    expect(send).not.toHaveBeenCalled();
  });

  it('сутки — камчатские, старые строки чистятся по сроку', async () => {
    await nudgePartnerOncePerDay('p1', 'operator_booking', vi.fn().mockResolvedValue('max'), new Date('2026-11-16T13:30:00Z'));
    // 13:30 UTC — уже 17.11 по Камчатке, но 01:30 — ночь: напоминания нет.
    expect(nudges.size).toBe(0);
    await nudgePartnerOncePerDay('p1', 'operator_booking', vi.fn().mockResolvedValue('max'), new Date('2026-11-16T20:30:00Z'));
    expect([...nudges.keys()]).toEqual(['p1|operator_booking|2026-11-17']);
    const prune = poolQueryMock.mock.calls.find(([s]) => s.includes('WHERE day <'));
    expect(prune?.[1]).toEqual(['2026-11-17', NUDGE_KEEP_DAYS]);
  });
});

describe('nudgeSummary — «уже напоминали» не выдаётся за недоставку', () => {
  it('называет каждый исход', () => {
    const s = nudgeSummary([
      { status: 'sent', channel: 'max' }, { status: 'already_today' }, { status: 'quiet' },
      { status: 'undelivered' }, { status: 'unknown' },
    ]);
    expect(s).toMatch(/уведомлено напрямую сейчас: 1/);
    expect(s).toMatch(/уже напоминали сегодня: 1/);
    expect(s).toMatch(/после 08:00: 1/);
    expect(s).toMatch(/не доставлено.*: 1/);
    expect(s).toMatch(/журнал напоминаний не ответил: 1/);
  });

  it('уже напоминали — не «не доставлено никому»', () => {
    expect(nudgeSummary([{ status: 'already_today' }])).not.toMatch(/не доставлено|не уведомлён/i);
    expect(nudgeSummary([])).toMatch(/нет ни MAX, ни Telegram/);
  });
});

describe('Watchdog: оператор без ответа 48 ч — напоминание раз в сутки', () => {
  const OP_ROW = {
    operator_id: 'p1', partner_slug: 'seller', partner_name: 'Продавец', partner_category: 'operator',
    telegram_chat_id: null, user_telegram_id: null, max_chat_id: '900', count: '2', oldest: '2026-11-10',
  };
  const STAY_ROW = {
    partner_id: 'p2', owner_name: 'Хозяин', telegram_chat_id: null, user_telegram_id: null,
    max_chat_id: '901', count: '1', oldest: '2026-11-14',
  };

  function routeWatchdog() {
    poolQueryMock.mockImplementation((sql: string, p?: unknown[]) => {
      const r = nudgeTable(sql, p);
      if (r) return Promise.resolve(r);
      if (sql.includes('p.slug AS partner_slug')) return Promise.resolve({ rows: [OP_ROW] });
      if (sql.includes('FROM accommodation_bookings b') && sql.includes('owner_name')) return Promise.resolve({ rows: [STAY_ROW] });
      if (sql.includes('FROM mcp_tool_calls')) return Promise.resolve({ rows: [{ calls: '5', callers: '2' }] });
      if (sql.includes('agent_run_history')) return Promise.resolve({ rows: [{ last_seen: new Date().toISOString() }] });
      return Promise.resolve({ rows: [] });
    });
  }

  it('три прогона за день — оператору и хозяину жилья по одному сообщению', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DAY);
    routeWatchdog();
    noticeMock.mockResolvedValue('max');
    await runWatchdog();
    await runWatchdog();
    await runWatchdog();
    const to = noticeMock.mock.calls.map(([target]) => (target as { maxChatId: string }).maxChatId).sort();
    expect(to).toEqual(['900', '901']);
  });

  it('ночью прогон партнёрам не пишет', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NIGHT);
    routeWatchdog();
    noticeMock.mockResolvedValue('max');
    await runWatchdog();
    expect(noticeMock).not.toHaveBeenCalled();
  });
});
