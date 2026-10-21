/**
 * Пул базы: потолки из config.database и замер в health (аудит 15.10, 1.15,
 * P3-13).
 *
 * Один пул на 20 соединений делят SOS, брони, кроны и главная. До 1.15 `max`,
 * ожидание соединения и простой стояли литералами в трёх ветках
 * buildPoolConfig, а DATABASE_MAX_CONNECTIONS объявлялся в config и docker-compose
 * и не читался никем. А решать, тесен ли пул, было не по чему: health не
 * говорил, сколько соединений занято и сколько запросов ждёт.
 *
 * Сторож — вызовом: что пул получил на самом деле (`options` у pg.Pool) при
 * разных переменных, и что отдаёт /api/health.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ENV_KEYS = ['DATABASE_MAX_CONNECTIONS', 'DATABASE_CONNECTION_TIMEOUT', 'DATABASE_IDLE_TIMEOUT', 'DATABASE_URL'] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  // Адрес без сети: пул создаётся, но ни одного соединения не открывает.
  process.env.DATABASE_URL = 'postgresql://u:p@127.0.0.1:1/none';
  vi.resetModules();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

/** Поднять пул (без соединений) и прочитать его замер. */
async function startedPool() {
  const mod = await import('@/lib/db-pool');
  mod.pool.on('error', () => {});
  return mod;
}

describe('потолки пула — из config.database', () => {
  it('без переменных — прежние значения: 20 соединений, ожидание 5 с, простой 30 с', async () => {
    const { poolStats } = await startedPool();
    expect(poolStats().limits).toEqual({ max: 20, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
  });

  it('переменные панели доходят до пула', async () => {
    process.env.DATABASE_MAX_CONNECTIONS = '12';
    process.env.DATABASE_CONNECTION_TIMEOUT = '3000';
    process.env.DATABASE_IDLE_TIMEOUT = '10000';
    const { poolStats } = await startedPool();
    expect(poolStats().limits).toEqual({ max: 12, connectionTimeoutMillis: 3000, idleTimeoutMillis: 10000 });
  });

  it('негодное значение — умолчание и строка в лог, а не NaN или ноль в пуле', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.DATABASE_MAX_CONNECTIONS = 'много';
    process.env.DATABASE_CONNECTION_TIMEOUT = '0';
    process.env.DATABASE_IDLE_TIMEOUT = '-5';
    const { poolStats } = await startedPool();
    expect(poolStats().limits).toEqual({ max: 20, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
    const keys = log.mock.calls.filter((c) => String(c[0]).includes('[db-pool]')).map((c) => (c[1] as { key: string }).key);
    expect(keys.sort()).toEqual(['connectionTimeoutMillis', 'idleTimeoutMillis', 'max']);
  });
});

describe('замер пула', () => {
  it('до первого запроса пула нет — так и сказано, без нулей', async () => {
    const { poolStats } = await import('@/lib/db-pool');
    const s = poolStats();
    expect(s.started).toBe(false);
    expect(s.total).toBeNull();
    expect(s.idle).toBeNull();
    expect(s.waiting).toBeNull();
  });

  it('пул поднят — счётчики pg: всего, свободно, ждут', async () => {
    const { poolStats } = await startedPool();
    expect(poolStats()).toMatchObject({ started: true, total: 0, idle: 0, waiting: 0 });
  });

  it('/api/health отдаёт замер пула рядом с памятью процесса', async () => {
    await startedPool();
    const { GET } = await import('@/app/api/health/route');
    const body = await (await GET()).json() as Record<string, unknown>;
    expect(body.db_pool).toMatchObject({ started: true, total: 0, idle: 0, waiting: 0, limits: { max: 20 } });
    expect(body.memory).toBeDefined();
  });
});
