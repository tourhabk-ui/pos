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
  checkMcpWrite, burstToReport, releaseWriteSlot, CLIENT_WINDOW_MINUTES, CLIENT_MAX_PER_WINDOW, CLIENT_MAX_PER_DAY, PHONE_MAX_PER_DAY,
  PHONE_MAX_SUBJECTS_PER_DAY,
} = await import('@/lib/mcp/write-guard');

const GUARD = readFileSync(join(process.cwd(), 'lib/mcp/write-guard.ts'), 'utf-8');
const ROUTE = readFileSync(join(process.cwd(), 'app/api/mcp/route.ts'), 'utf-8');

const base = { ip: '203.0.113.9', userAgent: 'agent/1.0', tool: 'create_lead', phone: '+79001112233', consent: true };

function txNoise(sql: string): boolean {
  return /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim()) || /pg_advisory_xact_lock/.test(sql);
}
function stubCounts(a: number, b: number, c: number, d = 0, e = 0) {
  poolQueryMock.mockImplementation((sql: string) => {
    if (!txNoise(sql) && /COUNT\(\*\)/.test(sql)) {
      return Promise.resolve({ rows: [{ a: String(a), b: String(b), c: String(c), d: String(d), e: String(e) }] });
    }
    if (/INSERT INTO mcp_write_attempts/.test(sql)) return Promise.resolve({ rows: [{ id: '42' }] });
    return Promise.resolve({ rows: [] });
  });
}
/** Параметры последней записи попытки: client_key, tool, phone_hash, outcome, subject_hash. */
function lastAttempt(): unknown[] {
  const calls = poolQueryMock.mock.calls.filter(([sql]) => /INSERT INTO mcp_write_attempts/.test(String(sql)));
  return calls[calls.length - 1]?.[1] as unknown[];
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
    // Окно и порог — константы стража (16.10), одни для роута и для /mcp.
    expect(CLIENT_WINDOW_MINUTES).toBe(60);
    expect(CLIENT_MAX_PER_WINDOW).toBe(5);
    expect(ROUTE).toMatch(/const writeLimiter = createRateLimiter\(\{ windowMs: CLIENT_WINDOW_MINUTES \* 60_000, max: CLIENT_MAX_PER_WINDOW \}\)/);
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

/**
 * Предмет заявки (аудит планировщика 07.11, M5 и M6).
 *
 * Порог «одна заявка на номер в сутки» стоял на паре «телефон + инструмент»:
 * второй тур того же плана слышал «на этот номер уже есть такая заявка…
 * менеджер свяжется по первой» — а такой заявки не было. Повтор той же
 * заявки при этом тоже упирался в порог, и ветка роута «на повтор — тот же
 * ответ, что на новую» была недостижима. А сбой сохранения после допуска
 * сжигал суточный слот: повтор слышал «уже есть», а заявки не было.
 */
describe('предмет заявки: повтор, следующий тур плана и сбой сохранения', () => {
  const booking = { ...base, tool: 'create_booking_request' };

  it('другой тур того же номера — допуск, а не «уже есть такая заявка»', async () => {
    stubCounts(0, 1, 1, 0, 0);
    const v = await checkMcpWrite({ ...booking, subject: '27|2027-07-12' });
    expect(v).toEqual({ decision: 'allow', attemptId: '42', repeat: false });
    expect(lastAttempt()[3]).toBe('allowed');
  });

  it('повтор того же тура и даты — допуск без нового слота: второй лид не создаётся в роуте', async () => {
    stubCounts(0, 1, 1, 0, 1);
    const v = await checkMcpWrite({ ...booking, subject: '27|2027-07-10' });
    expect(v).toEqual({ decision: 'allow', attemptId: null, repeat: true });
    // Строка повтора — не «принятая»: в порог номера не идёт и освобождать её нечего.
    expect(lastAttempt()[3]).toBe('repeat');
  });

  it(`разных предметов на номер за сутки — не больше ${PHONE_MAX_SUBJECTS_PER_DAY}: дальше карантин с правдивой причиной`, async () => {
    stubCounts(0, 2, PHONE_MAX_SUBJECTS_PER_DAY, 0, 0);
    const v = await checkMcpWrite({ ...booking, subject: '31|2027-07-20' });
    expect(v.decision === 'deny' && v.outcome).toBe('quarantined');
    expect(v.decision === 'deny' && v.message).toContain(`уже ${PHONE_MAX_SUBJECTS_PER_DAY} заявок`);
    expect(v.decision === 'deny' && v.message).not.toMatch(/по первой/);
  });

  it('поток повторов с одного адреса держит лимит клиента', async () => {
    stubCounts(CLIENT_MAX_PER_WINDOW, CLIENT_MAX_PER_WINDOW, 1, 0, 1);
    const v = await checkMcpWrite({ ...booking, subject: '27|2027-07-10' });
    expect(v.decision === 'deny' && v.outcome).toBe('rate_limited');
  });

  it('без предмета — как прежде: одна заявка на номер в сутки', async () => {
    stubCounts(0, 1, 1, 0, 0);
    const v = await checkMcpWrite(base);
    expect(v.decision === 'deny' && v.message).toMatch(/Менеджер свяжется по первой/);
  });

  it('предмет в журнале — отпечатком, а не номером тура и датой', async () => {
    stubCounts(0, 0, 0);
    await checkMcpWrite({ ...booking, subject: '27|2027-07-10' });
    const subjectHash = String(lastAttempt()[4]);
    expect(subjectHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(poolQueryMock.mock.calls)).not.toContain('2027-07-10');
    // Без предмета колонка пуста — порог «одна на номер» считает свои строки.
    stubCounts(0, 0, 0);
    await checkMcpWrite(base);
    expect(lastAttempt()[4]).toBeNull();
  });

  it('сбой сохранения после допуска освобождает слот: строка допуска становится save_failed', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    await releaseWriteSlot('42');
    const [sql, params] = poolQueryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE mcp_write_attempts SET outcome = 'save_failed'/);
    expect(sql).toMatch(/AND outcome = 'allowed'/);
    expect(params).toEqual(['42']);
  });

  it('нечего освобождать — запроса нет; отказ правки не глушится и не бросается', async () => {
    await releaseWriteSlot(null);
    expect(poolQueryMock).not.toHaveBeenCalled();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    poolQueryMock.mockRejectedValueOnce(Object.assign(new Error('down'), { code: '57P01' }));
    await expect(releaseWriteSlot('42')).resolves.toBeUndefined();
    expect(err.mock.calls[0]?.[0]).toBe('[mcp-write-guard] слот не освобождён после сбоя сохранения:');
    err.mockRestore();
  });
});

describe('запрет: «не удалось сохранить» без освобождения слота', () => {
  // Сбой сохранения после допуска сжигал суточный слот номера (аудит 07.11,
  // M6). Сценарий через POST собран для брони и машины; у проката, жилья и
  // подбора он дорогой (два шага проката, доставка жилья) — здесь держится
  // запрет: каждый отказ save_failed в роуте идёт сразу после освобождения.
  it('каждый throw save_failed в роуте стоит сразу после releaseWriteSlot', () => {
    const sites = [...ROUTE.matchAll(/throw new McpUserError\([^;]*'save_failed'\);/g)];
    expect(sites.length).toBe(5);
    for (const m of sites) {
      const before = ROUTE.slice(0, m.index).trimEnd().split('\n').pop() ?? '';
      expect(before.trim(), ROUTE.slice(m.index!, m.index! + 80)).toBe('await releaseWriteSlot(admitted.slot);');
    }
  });
});
