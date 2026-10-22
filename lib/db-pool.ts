/**
 * Shared Database Pool — LAZY initialization
 * Не создаёт подключение к БД при импорте модуля.
 * Подключение происходит только при первом запросе.
 * Критично для Timeweb: сервер должен стартовать <3 мин.
 */

import { Pool } from 'pg';
import { config } from '@/lib/config';

// DATABASE_SSL=false явно отключает SSL (даже в production).
// По умолчанию — SSL включён в production, выключен в dev.
const useSSL = process.env.DATABASE_SSL === 'false'
  ? false
  : (config.database.ssl || process.env.NODE_ENV === 'production');

function normalizeDatabaseUrl(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.replace(/^['"]+|['"]+$/g, '');
}

function sanitizeMalformedPostgresUrl(raw: string): string {
  const normalized = normalizeDatabaseUrl(raw);
  if (!/^postgres(ql)?:\/\//i.test(normalized)) return normalized;
  const m = normalized.match(/^(postgres(?:ql)?:\/\/)([^:/?#]+):(.+)@([^:/?#]+):(\d+)\/(.+)$/i);
  if (!m) return normalized;
  const [, scheme, usernameRaw, passwordRaw, host, port, dbPart] = m;
  return `${scheme}${encodeURIComponent(usernameRaw)}:${encodeURIComponent(passwordRaw)}@${host}:${port}/${dbPart}`;
}

// Timeweb переназначил БД с публичного IP на приватную сеть.
// Маппим оба варианта (hostname и старый публичный IP) на новый приватный IP.
// DB_HOST_IP — env var для смены IP без передеплоя кода.
const newIp = process.env.DB_HOST_IP ?? '192.168.0.4';
const KNOWN_HOST_MAP: Record<string, string> = {
  '8ad609fcbfd2ad0bd069be47.twc1.net': newIp,
  '94.228.112.62': newIp,
};

function resolveHost(host: string): string {
  return KNOWN_HOST_MAP[host] ?? host;
}

/**
 * Потолки пула — из config.database (аудит 15.10, 1.15, P3-13). До 22.10 они
 * стояли литералами в трёх ветках buildPoolConfig, а DATABASE_MAX_CONNECTIONS
 * объявлялся в config и docker-compose и не читался никем. Умолчания — те
 * самые литералы: без переменных поведение пула не меняется. Негодное
 * значение (не число, ноль, вне границ) — умолчание и строка в лог, а не NaN
 * в пуле.
 *
 * statement_timeout здесь НЕТ намеренно. Пул общий: его делят SOS, три
 * приёмника оплаты и контроль выхода (зоны §7), и потолок на запрос меняет их
 * поведение разом — только через staging или слово владельца (аудит, 1.15,
 * «Риск»).
 */
export interface PoolLimits {
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
}

const POOL_DEFAULTS: PoolLimits = { max: 20, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000 };
const POOL_BOUNDS: Record<keyof PoolLimits, readonly [number, number]> = {
  max: [1, 100],
  connectionTimeoutMillis: [500, 60_000],
  idleTimeoutMillis: [1_000, 600_000],
};

function poolLimits(): PoolLimits {
  const raw: PoolLimits = {
    max: config.database.maxConnections,
    connectionTimeoutMillis: config.database.connectionTimeout,
    idleTimeoutMillis: config.database.idleTimeout,
  };
  const out = { ...POOL_DEFAULTS };
  for (const key of Object.keys(POOL_DEFAULTS) as (keyof PoolLimits)[]) {
    const [lo, hi] = POOL_BOUNDS[key];
    const v = raw[key];
    if (Number.isInteger(v) && v >= lo && v <= hi) out[key] = v;
    else console.error('[db-pool] негодный потолок пула — взято умолчание', { key, value: String(v), default: POOL_DEFAULTS[key] });
  }
  return out;
}

function buildPoolConfig() {
  const limits = poolLimits();
  const rawDbUrl = normalizeDatabaseUrl(config.database.url || '');
  const dbUrl = sanitizeMalformedPostgresUrl(rawDbUrl);
  const manual = rawDbUrl.match(/^(postgres(?:ql)?:\/\/)([^:/?#]+):(.+)@([^:/?#]+):(\d+)\/(.+)$/i)
    ?? dbUrl.match(/^(postgres(?:ql)?:\/\/)([^:/?#]+):(.+)@([^:/?#]+):(\d+)\/(.+)$/i);

  if (manual) {
    const [, , usernameRaw, passwordRaw, host, portRaw, dbPart] = manual;
    const decodeSafe = (v: string) => { try { return decodeURIComponent(v); } catch { return v; } };
    const [dbName] = dbPart.split('?');
    return { user: decodeSafe(usernameRaw), password: decodeSafe(passwordRaw), host: resolveHost(host), port: parseInt(portRaw, 10), database: dbName, ssl: useSSL ? { rejectUnauthorized: false } : false, ...limits };
  }

  try {
    const parsed = new URL(dbUrl);
    if (parsed.protocol === 'postgresql:' || parsed.protocol === 'postgres:') {
      return { user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password), host: resolveHost(parsed.hostname), port: parsed.port ? parseInt(parsed.port, 10) : 5432, database: parsed.pathname.replace(/^\//, ''), ssl: useSSL ? { rejectUnauthorized: false } : false, ...limits };
    }
  } catch { /* fall through */ }

  return { connectionString: dbUrl, ssl: useSSL ? { rejectUnauthorized: false } : false, ...limits };
}

// Lazy pool — connection created only on first use
let _pool: Pool | null = null;
let _limits: PoolLimits | null = null;
function getPool(): Pool {
  if (!_pool) {
    const cfg = buildPoolConfig();
    _limits = { max: cfg.max, connectionTimeoutMillis: cfg.connectionTimeoutMillis, idleTimeoutMillis: cfg.idleTimeoutMillis };
    _pool = new Pool(cfg);
  }
  return _pool;
}

export interface PoolStats {
  /** Пул создан. false — с начала процесса не было ни одного запроса. */
  started: boolean;
  /** Соединений открыто, из них свободно, и запросов в очереди за соединением. */
  total: number | null;
  idle: number | null;
  waiting: number | null;
  /** С чем пул создан; до создания — что он получит. */
  limits: PoolLimits;
}

/**
 * Замер пула для /api/health (аудит 15.10, 1.15): тесен ли пул на 2 ядрах и
 * 4 ГБ, решается по waiting и total, а не по догадке. До первого запроса
 * пула нет — счётчики null («не знаю»), а не нули («пусто»).
 */
export function poolStats(): PoolStats {
  if (!_pool) return { started: false, total: null, idle: null, waiting: null, limits: _limits ?? poolLimits() };
  return {
    started: true,
    total: _pool.totalCount,
    idle: _pool.idleCount,
    waiting: _pool.waitingCount,
    limits: _limits ?? poolLimits(),
  };
}

export const pool = {
  connect: (...args: unknown[]) => getPool().connect(...args as [any]),
  query: (...args: unknown[]) => getPool().query(...args as [string, unknown[]?]),
  end: () => _pool?.end(),
  on: (...args: unknown[]) => getPool().on(...args as ['error' | 'connect' | 'acquire' | 'remove' | 'release', (...args: unknown[]) => void]),
} as unknown as Pool;
