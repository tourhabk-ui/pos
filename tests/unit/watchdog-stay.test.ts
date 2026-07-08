/**
 * tests/unit/watchdog-stay.test.ts
 *
 * Watchdog сторожит pending-брони жилья (PR 3 цикла «жизненный цикл брони»):
 * - запрос по accommodation_bookings status='pending' старше 24ч;
 * - при наличии строк — алерт unconfirmed_stay_booking в сводке;
 * - пусто → алерта нет.
 * Остальные проверки watchdog замоканы пустыми выборками.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const poolQueryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => poolQueryMock(sql, params) },
}));

// knowledgeBase не должен вызываться (операторская выборка пуста), но мокаем на всякий
vi.mock('@/lib/agents/memory/agent-knowledge', () => ({
  knowledgeBase: {
    upsert: vi.fn().mockResolvedValue(undefined),
    appendTimeline: vi.fn().mockResolvedValue(undefined),
  },
}));

import { runWatchdog } from '@/lib/agents/watchdog';

const STAY_MARKER = 'FROM accommodation_bookings b';

function routeQueries(stayRows: unknown[]) {
  poolQueryMock.mockImplementation((sql: string) => {
    if (sql.includes(STAY_MARKER)) return Promise.resolve({ rows: stayRows });
    // seismic: непустой last_seen «только что» → без ложного КРИТ-алерта
    if (sql.includes('agent_run_history')) {
      return Promise.resolve({ rows: [{ last_seen: new Date().toISOString() }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  poolQueryMock.mockReset();
  // без токена Telegram — сетевые вызовы не уходят
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
});

describe('watchdog: pending-брони жилья', () => {
  it('запрос — accommodation_bookings status=pending старше 24ч', async () => {
    routeQueries([]);
    await runWatchdog();
    const stayCall = poolQueryMock.mock.calls.find(([sql]) => String(sql).includes(STAY_MARKER));
    expect(stayCall).toBeTruthy();
    const sql = String(stayCall![0]);
    expect(sql).toContain("b.status = 'pending'");
    expect(sql).toContain("INTERVAL '24 hours'");
    expect(sql).toContain('JOIN accommodations a');
    expect(sql).toContain('LEFT JOIN partners p');
  });

  it('есть просроченные pending → алерт unconfirmed_stay_booking с суммой', async () => {
    routeQueries([
      { partner_id: 'p1', owner_name: 'Дом у вулкана', telegram_chat_id: null, count: '2', oldest: '2026-07-01' },
      { partner_id: 'p2', owner_name: 'Гостевой двор', telegram_chat_id: null, count: '3', oldest: '2026-07-02' },
    ]);
    const result = await runWatchdog();
    const alert = result.alerts.find(a => a.type === 'unconfirmed_stay_booking');
    expect(alert).toBeTruthy();
    expect(alert!.count).toBe(5); // 2 + 3 броней у 2 владельцев
    expect(alert!.details).toContain('2 владельц');
  });

  it('нет просроченных pending → алерта нет', async () => {
    routeQueries([]);
    const result = await runWatchdog();
    expect(result.alerts.some(a => a.type === 'unconfirmed_stay_booking')).toBe(false);
  });
});
