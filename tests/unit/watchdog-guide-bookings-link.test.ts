/**
 * Напоминание Watchdog «бронь без ответа больше 48 часов» — куда ведёт кнопка.
 *
 * Свои туры продаёт и гид (1338), а кабинет броней оператора его не пускает
 * (категория не operator). Кнопка «Мои бронирования» вела гида на отказ:
 * напоминание доходило, а ответить на бронь по нему было нельзя. Теперь гиду —
 * «Свои туры», оператору — кабинет броней, как было.
 *
 * Поведением на моках пула — тем же приёмом, что watchdog-stay.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { poolQueryMock, noticeMock } = vi.hoisted(() => ({
  poolQueryMock: vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>(),
  noticeMock: vi.fn(),
}));
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => poolQueryMock(sql, params) },
}));
vi.mock('@/lib/partners/notice', () => ({ sendPartnerNotice: noticeMock }));
vi.mock('@/lib/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/config')>()),
  getPublicBaseUrl: () => 'https://vedarai.ru',
}));
vi.mock('@/lib/agents/memory/agent-knowledge', () => ({
  knowledgeBase: {
    upsert: vi.fn().mockResolvedValue(undefined),
    appendTimeline: vi.fn().mockResolvedValue(undefined),
  },
}));
// Файл не про MCP: окно «канал молчит» считается от настоящих часов.
vi.mock('@/lib/mcp/catalogs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mcp/catalogs')>()),
  MCP_SILENCE_ALERT_FROM_DAYS: Number.POSITIVE_INFINITY,
}));

import { runWatchdog } from '@/lib/agents/watchdog';

const NO_RESPONSE = 'p.slug AS partner_slug';
const row = (over: Record<string, unknown>) => ({
  operator_id: 'p1', partner_slug: 'seller', partner_name: 'Продавец', partner_category: 'operator',
  telegram_chat_id: null, user_telegram_id: null, max_chat_id: '900', count: '2', oldest: '2026-10-25',
  ...over,
});

function route(rows: unknown[]) {
  poolQueryMock.mockImplementation((sql: string) => {
    if (sql.includes(NO_RESPONSE)) return Promise.resolve({ rows });
    if (sql.includes('FROM mcp_tool_calls')) return Promise.resolve({ rows: [{ calls: '5', callers: '2' }] });
    if (sql.includes('agent_run_history')) return Promise.resolve({ rows: [{ last_seen: new Date().toISOString() }] });
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  poolQueryMock.mockReset();
  noticeMock.mockReset();
  noticeMock.mockResolvedValue('max');
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('Watchdog: напоминание о брони без ответа', () => {
  it('категория продавца спрашивается у базы и входит в группировку', async () => {
    route([]);
    await runWatchdog();
    const sql = String(poolQueryMock.mock.calls.find(([s]) => String(s).includes(NO_RESPONSE))![0]);
    expect(sql).toMatch(/p\.category AS partner_category/);
    expect(sql).toMatch(/GROUP BY[^`]*p\.category/);
  });

  it('гиду — «Свои туры», оператору — кабинет броней', async () => {
    route([
      row({ operator_id: 'g1', partner_slug: 'guide-own', partner_name: 'Гид своих туров', partner_category: 'guide', max_chat_id: '901' }),
      row({ operator_id: 'o1', partner_slug: 'op', partner_name: 'Оператор', partner_category: 'operator', max_chat_id: '902' }),
    ]);
    await runWatchdog();
    const links = Object.fromEntries(noticeMock.mock.calls.map(([to, , link]) => [
      (to as { maxChatId: string }).maxChatId, link as { text: string; url: string },
    ]));
    expect(links['901']).toEqual({ text: 'Мои бронирования', url: 'https://vedarai.ru/hub/guide/own' });
    expect(links['902']).toEqual({ text: 'Мои бронирования', url: 'https://vedarai.ru/hub/operator/bookings' });
  });
});
