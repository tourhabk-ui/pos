/**
 * Пул базы: соединение не получено — один повтор, строка с замером пула
 * (#3805–#3820: «timeout exceeded when trying to connect» на десятке
 * страниц за сутки, по одной-три ошибки на маршрут).
 *
 * Запрос, который не дождался соединения, в базу не уходил, поэтому повтор
 * безопасен и для записи. Другие ошибки (SQL, нарушение ограничения) не
 * повторяются: их повтор либо бесполезен, либо опасен.
 *
 * Сторож — вызовом: pg.Pool подменён, первый вызов отказывает так, как
 * отказывает настоящий pg-pool, второй отвечает.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const queryMock = vi.fn();
const connectMock = vi.fn();
const onMock = vi.fn();
let poolOptions: Record<string, unknown> | null = null;

vi.mock('pg', () => {
  class Pool {
    totalCount = 20;
    idleCount = 0;
    waitingCount = 7;
    constructor(opts: Record<string, unknown>) { poolOptions = opts; }
    query = queryMock;
    connect = connectMock;
    on = onMock;
  }
  return { Pool, default: { Pool } };
});

const TIMEOUT = () => new Error('timeout exceeded when trying to connect');

beforeEach(() => {
  vi.resetModules();
  queryMock.mockReset();
  connectMock.mockReset();
  onMock.mockReset();
  poolOptions = null;
  process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:1/none';
});
afterEach(() => vi.restoreAllMocks());

describe('соединение не получено — один повтор', () => {
  it('query: первый вызов не дождался соединения, второй ответил', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    queryMock.mockRejectedValueOnce(TIMEOUT()).mockResolvedValueOnce({ rows: [{ ok: 1 }] });
    const { pool } = await import('@/lib/db-pool');
    const res = await pool.query('SELECT 1');
    expect(res.rows).toEqual([{ ok: 1 }]);
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[1]).toEqual(['SELECT 1']);
    // В журнале — замер пула: все 20 заняты, 7 ждут.
    const line = log.mock.calls.find((c) => String(c[0]).includes('соединение не получено'));
    expect(line?.[1]).toMatchObject({ op: 'query', retried: false, total: 20, idle: 0, waiting: 7, max: 20 });
  });

  it('query: оба раза нет соединения — ошибка наружу, повторов больше нет', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    queryMock.mockRejectedValue(TIMEOUT());
    const { pool } = await import('@/lib/db-pool');
    await expect(pool.query('SELECT 1')).rejects.toThrow(/timeout exceeded/);
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('query: ошибка SQL не повторяется', async () => {
    queryMock.mockRejectedValueOnce(Object.assign(new Error('duplicate key value'), { code: '23505' }));
    const { pool } = await import('@/lib/db-pool');
    await expect(pool.query('INSERT 1')).rejects.toThrow(/duplicate key/);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('connect: соединение получено со второго раза', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = { query: vi.fn(), release: vi.fn() };
    connectMock.mockRejectedValueOnce(TIMEOUT()).mockResolvedValueOnce(client);
    const { pool } = await import('@/lib/db-pool');
    await expect(pool.connect()).resolves.toBe(client);
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it('connect с колбэком идёт как есть, без обёртки', async () => {
    const { pool } = await import('@/lib/db-pool');
    const cb = vi.fn();
    (pool.connect as unknown as (cb: unknown) => void)(cb);
    expect(connectMock).toHaveBeenCalledWith(cb);
  });
});

describe('пул не роняет процесс при обрыве простаивающего соединения', () => {
  it('слушатель error стоит с момента создания, keepAlive включён', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const { pool } = await import('@/lib/db-pool');
    await pool.query('SELECT 1');
    expect(poolOptions).toMatchObject({ keepAlive: true });
    const handler = onMock.mock.calls.find((c) => c[0] === 'error')?.[1] as ((e: Error) => void) | undefined;
    expect(handler).toBeTypeOf('function');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    handler!(new Error('Connection terminated unexpectedly'));
    expect(String(log.mock.calls[0]?.[0])).toContain('обрыв простаивающего соединения');
  });
});
