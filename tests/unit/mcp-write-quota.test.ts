/**
 * Квота записи публичного MCP — решение владельца 01.10 (разбор аудита):
 * «квота на запись, не ключ». Ключ сломал бы публичный коннектор.
 *
 *   - 5 заявок в час и 20 в сутки с адреса;
 *   - дедуп по телефону за сутки — в пределах инструмента (подбор и бронь
 *     даты — разные намерения);
 *   - всплеск — сигнал оператору в Telegram, один раз, а не на каждый отказ;
 *     в сигнале нет ни телефона, ни адреса.
 *
 * Механика стража (замки, отпечатки, согласие) — в mcp-write-policy.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.MCP_HASH_SALT = 'test-salt';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (...args: unknown[]) => poolQueryMock(...args),
    connect: async () => ({
      query: (...args: unknown[]) => poolQueryMock(...args),
      release: () => {},
    }),
  },
}));

const tgSendMock = vi.fn(async () => ({ ok: true as const }));
vi.mock('@/lib/notifications/tg-send', () => ({ tgSend: (...a: unknown[]) => tgSendMock(...(a as [])) }));

const {
  checkMcpWrite, burstToReport, CLIENT_WINDOW_MINUTES, CLIENT_MAX_PER_WINDOW, CLIENT_MAX_PER_DAY, PHONE_MAX_PER_DAY,
} = await import('@/lib/mcp/write-guard');

const GUARD = readFileSync(join(process.cwd(), 'lib/mcp/write-guard.ts'), 'utf-8');
const ROUTE = readFileSync(join(process.cwd(), 'app/api/mcp/route.ts'), 'utf-8');

const base = { ip: '203.0.113.9', userAgent: 'agent/1.0', tool: 'create_lead', phone: '+79001112233', consent: true };

function txNoise(sql: string): boolean {
  return /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim()) || /pg_advisory_xact_lock/.test(sql);
}
function stubCounts(a: number, b: number, c: number, d = 0) {
  poolQueryMock.mockImplementation((sql: string) =>
    !txNoise(sql) && /COUNT\(\*\)/.test(sql)
      ? Promise.resolve({ rows: [{ a: String(a), b: String(b), c: String(c), d: String(d) }] })
      : Promise.resolve({ rows: [] }));
}

beforeEach(() => { poolQueryMock.mockReset(); tgSendMock.mockClear(); });

describe('пороги владельца', () => {
  it('5 в час, 20 в сутки, одна заявка на номер', () => {
    expect(CLIENT_WINDOW_MINUTES).toBe(60);
    expect(CLIENT_MAX_PER_WINDOW).toBe(5);
    expect(CLIENT_MAX_PER_DAY).toBe(20);
    expect(PHONE_MAX_PER_DAY).toBe(1);
  });

  it('счётчик в памяти роута — то же окно в час', () => {
    expect(ROUTE).toMatch(/const writeLimiter = createRateLimiter\(\{ windowMs: 3_600_000, max: 5 \}\)/);
    expect(ROUTE).not.toMatch(/подождите 10 минут/);
  });

  it('дедуп номера — в пределах инструмента', () => {
    expect(GUARD).toMatch(/AND tool = \$4::varchar\(64\)\s*AND outcome = 'allowed'\)::text AS c/);
  });

  it('вторая заявка на тот же номер — отказ с понятной причиной', async () => {
    stubCounts(0, 0, 1);
    const v = await checkMcpWrite(base);
    expect(v.decision === 'deny' && v.outcome).toBe('quarantined');
    expect(v.decision === 'deny' && v.message).toMatch(/Менеджер свяжется по первой/);
  });

  it('суточный предел назван суточным, а не «подождите час»', async () => {
    stubCounts(2, CLIENT_MAX_PER_DAY, 0);
    const v = await checkMcpWrite(base);
    expect(v.decision === 'deny' && v.message).toMatch(/суточный предел/);
  });
});

describe('всплеск — оператору, один раз', () => {
  it('первый отказ по окну — сигнал; следующий — тишина', () => {
    const c = (a: number, b = a) => ({ by_client_window: a, by_client_day: b, by_phone_day: 0, phone_quarantined_recent: 0 });
    expect(burstToReport(c(CLIENT_MAX_PER_WINDOW), 'rate_limited')).toBe('client_window');
    expect(burstToReport(c(CLIENT_MAX_PER_WINDOW + 1), 'rate_limited')).toBeNull();
    expect(burstToReport(c(2, CLIENT_MAX_PER_DAY), 'rate_limited')).toBe('client_day');
    expect(burstToReport(c(0), 'allowed')).toBeNull();
  });

  it('повтор номера — сигнал, пока за час не было карантина', () => {
    const c = (d: number) => ({ by_client_window: 0, by_client_day: 0, by_phone_day: 1, phone_quarantined_recent: d });
    expect(burstToReport(c(0), 'quarantined')).toBe('phone_repeat');
    expect(burstToReport(c(1), 'quarantined')).toBeNull();
  });

  it('сигнал уходит в Telegram и не несёт ни телефона, ни адреса', async () => {
    stubCounts(CLIENT_MAX_PER_WINDOW, CLIENT_MAX_PER_WINDOW, 0);
    await checkMcpWrite(base);
    expect(tgSendMock).toHaveBeenCalledTimes(1);
    const text = String((tgSendMock.mock.calls[0] as unknown[])[1]);
    expect(text).toMatch(/всплеск записи \(create_lead\)/);
    expect(text).not.toContain(base.phone);
    expect(text).not.toContain(base.ip);
  });

  it('обычная заявка сигнала не шлёт', async () => {
    stubCounts(0, 0, 0);
    expect((await checkMcpWrite(base)).decision).toBe('allow');
    expect(tgSendMock).not.toHaveBeenCalled();
  });

  it('отказ отправки не глушится и решения не меняет', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    tgSendMock.mockResolvedValueOnce({ ok: false, reason: 'нет токена' } as never);
    stubCounts(CLIENT_MAX_PER_WINDOW, CLIENT_MAX_PER_WINDOW, 0);
    const v = await checkMcpWrite(base);
    expect(v.decision === 'deny' && v.outcome).toBe('rate_limited');
    expect(err).toHaveBeenCalledWith('[mcp-write-guard] сигнал о всплеске не отправлен:', 'нет токена');
    err.mockRestore();
  });
});
