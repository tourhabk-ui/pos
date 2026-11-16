/**
 * Учёт входящих апдейтов Telegram и MAX в базе (#3433 п. 1, слово владельца
 * 16.11 «Оба шага»): повтор узнаётся и после перезапуска процесса, а база,
 * не ответившая вовремя, — «не смог», и решает память процесса.
 * Вызовом lib/chat/inbound-seen; вебхуки — в telegram-webhook-kuzmich-brain и
 * max-verified-press.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const m = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => m.query(...a) } }));

const { recordInboundInDb, isRepeatedInbound } = await import('@/lib/chat/inbound-seen');

/** Таблица chat_inbound_seen в памяти теста. */
const table = new Map<string, number>();
const realTable = async (sql: unknown, params?: unknown[]) => {
  const q = String(sql);
  if (q.startsWith('INSERT INTO chat_inbound_seen')) {
    const key = `${String(params?.[0])}:${String(params?.[1])}`;
    const hits = (table.get(key) ?? 0) + 1;
    table.set(key, hits);
    return { rows: [{ hits }] };
  }
  if (q.startsWith('DELETE FROM chat_inbound_seen')) return { rows: [], rowCount: 0 };
  throw new Error(`неожиданный запрос: ${q}`);
};

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  table.clear();
  m.query.mockReset();
  m.query.mockImplementation(realTable);
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  errorLog.mockRestore();
});

describe('recordInboundInDb: три исхода', () => {
  it('первая доставка — new, вторая — repeat; источники не смешиваются', async () => {
    expect(await recordInboundInDb('telegram', '101')).toBe('new');
    expect(await recordInboundInDb('telegram', '101')).toBe('repeat');
    expect(await recordInboundInDb('max_message', '101')).toBe('new');
    expect(await recordInboundInDb('max_callback', '101')).toBe('new');
  });

  it('в базу уходит только источник и номер апдейта', async () => {
    await recordInboundInDb('max_message', 'mid.abc');
    expect(m.query.mock.calls[0][1]).toEqual(['max_message', 'mid.abc']);
  });

  it('отказ базы — unknown, в логе код отказа', async () => {
    m.query.mockRejectedValueOnce(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    expect(await recordInboundInDb('telegram', '7')).toBe('unknown');
    expect(String(errorLog.mock.calls[0][0])).toMatch(/\[chat\/inbound-seen\].*42P01/);
  });

  it('ответ не той формы — unknown, а не «повтор»', async () => {
    for (const res of [{ rows: [] }, { rows: [{ hits: null }] }, { rows: [{}, {}] }, undefined]) {
      m.query.mockResolvedValueOnce(res);
      expect(await recordInboundInDb('telegram', '8')).toBe('unknown');
    }
  });

  it('база молчит дольше двух секунд — unknown, вебхук не ждёт', async () => {
    vi.useFakeTimers();
    m.query.mockReturnValueOnce(new Promise(() => undefined));
    const verdict = recordInboundInDb('telegram', '9');
    await vi.advanceTimersByTimeAsync(2001);
    expect(await verdict).toBe('unknown');
  });

  it('пустой или слишком длинный ключ — unknown без запроса', async () => {
    expect(await recordInboundInDb('telegram', '')).toBe('unknown');
    expect(await recordInboundInDb('telegram', 'x'.repeat(201))).toBe('unknown');
    expect(m.query).not.toHaveBeenCalled();
  });

  it('строки старше суток удаляются по ходу записи', async () => {
    for (let i = 0; i < 100; i++) await recordInboundInDb('telegram', `c${i}`);
    const deletes = m.query.mock.calls.filter((c) => String(c[0]).startsWith('DELETE'));
    expect(deletes).toHaveLength(1);
    expect(String(deletes[0][0])).toContain("interval '1 day'");
  });
});

describe('isRepeatedInbound: память процесса, затем база', () => {
  it('память видела — повтор без похода в базу', async () => {
    expect(await isRepeatedInbound('telegram', '1', () => true)).toBe(true);
    expect(m.query).not.toHaveBeenCalled();
  });

  it('после перезапуска память пуста, база помнит — повтор', async () => {
    expect(await isRepeatedInbound('telegram', '2', () => false)).toBe(false);
    expect(await isRepeatedInbound('telegram', '2', () => false)).toBe(true);
  });

  it('база не ответила — решает память: не видела — новый', async () => {
    m.query.mockRejectedValue(new Error('down'));
    expect(await isRepeatedInbound('telegram', '3', () => false)).toBe(false);
  });
});
