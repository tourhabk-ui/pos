// @vitest-environment node
/**
 * Крон health будит владельца, когда контейнер стартовал со схемой,
 * отстающей от кода (аудит 15.10, A08, ответ на вопрос 8).
 *
 * start.js отказ наката не роняет — SOS и полевой контур важнее новой фичи, —
 * и передаёт исход в Next через env MIGRATIONS_STARTUP_STATE. Сказать о нём
 * владельцу может только сторож. Watchdog читает `_migration_failures`, но
 * таймаут наката и базу, не пустившую раннер, та таблица не видит никогда.
 *
 * Сторож судит поведение (CLAUDE.md §4, 13.10): разбор env и находка — на
 * граничных данных; проводка — вызов настоящего GET крона с подменёнными
 * базой, пробами и Telegram: что ушло в сводку и что легло в ответ.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  parseStartupMigrationsState,
  startupMigrationsIssue,
} from '@/lib/agents/migration-startup-state';

const PHONE = '+7 914 123-45-67';
const AT = '2026-10-15T03:00:00.000Z';
const FAILED = JSON.stringify({
  state: 'failed', reason: 'file_failed', file: '1300_tour_access.sql', sqlstate: '42703', failed_count: 2, at: AT,
  error: `value ${PHONE}`,
});

describe('разбор состояния из env', () => {
  it('нет переменной — unknown not_recorded, а не ok', () => {
    expect(parseStartupMigrationsState(undefined)).toMatchObject({ state: 'unknown', reason: 'not_recorded' });
    expect(parseStartupMigrationsState('  ')).toMatchObject({ state: 'unknown', reason: 'not_recorded' });
  });

  it('мусор — unknown unreadable', () => {
    for (const raw of ['{', '[]', '"ok"', '{"state":"fine"}', 'null']) {
      expect(parseStartupMigrationsState(raw), raw).toMatchObject({ state: 'unknown', reason: 'unreadable' });
    }
  });

  it('failed читается с файлом, SQLSTATE и временем; лишние поля не проходят', () => {
    const m = parseStartupMigrationsState(FAILED);
    expect(m).toEqual({ state: 'failed', reason: 'file_failed', file: '1300_tour_access.sql', sqlstate: '42703', failed_count: 2, at: AT });
  });

  it('поля не своей формы — null, а не текст ошибки', () => {
    const m = parseStartupMigrationsState(JSON.stringify({ state: 'failed', reason: 'x y', file: `${PHONE}`, sqlstate: 'EPIPE', at: 'вчера' }));
    expect(m).toEqual({ state: 'failed', reason: 'unspecified', file: null, sqlstate: null, failed_count: null, at: null });
  });
});

describe('находка health-крона', () => {
  it('failed — CRIT с файлом, SQLSTATE и временем старта', () => {
    const i = startupMigrationsIssue(parseStartupMigrationsState(FAILED));
    expect(i?.level).toBe('crit');
    expect(i?.text).toMatch(/Схема БД отстаёт от кода/);
    expect(i?.text).toContain('1300_tour_access.sql');
    expect(i?.text).toContain('SQLSTATE 42703');
    expect(i?.text).toContain('всего упавших файлов: 2');
    expect(i?.text).toContain(AT);
    expect(i?.text).not.toContain('914');
  });

  it('таймаут и аварийный выход называются словами, неизвестный файл — «неизвестно какой»', () => {
    const t = startupMigrationsIssue({ state: 'failed', reason: 'timeout', file: '1301_slow.sql', sqlstate: null, failed_count: null, at: null });
    expect(t?.text).toMatch(/не уложился в MIGRATE_TIMEOUT_MS.*1301_slow\.sql/);
    const e = startupMigrationsIssue({ state: 'failed', reason: 'exit_1', file: null, sqlstate: null, failed_count: null, at: null });
    expect(e?.level).toBe('crit');
    expect(e?.text).toMatch(/аварийно \(exit_1\), файл: неизвестно какой файл/);
  });

  it('unknown — WARN с причиной; ok — молчание', () => {
    const u = startupMigrationsIssue(parseStartupMigrationsState(undefined));
    expect(u?.level).toBe('warn');
    expect(u?.text).toMatch(/неизвестен \(not_recorded\)/);
    expect(startupMigrationsIssue(parseStartupMigrationsState(JSON.stringify({ state: 'ok', reason: 'applied', at: AT })))).toBeNull();
  });

  it('раннер не достучался до базы — WARN «не знаю», а не CRIT «схема отстаёт» (ревью A08)', () => {
    const f = startupMigrationsIssue(parseStartupMigrationsState(JSON.stringify({ state: 'unknown', reason: 'fatal', sqlstate: '28P01', at: AT })));
    expect(f?.level).toBe('warn');
    expect(f?.text).toMatch(/не достучался до базы \(SQLSTATE 28P01\)/);
    expect(f?.text).not.toMatch(/отстаёт от кода:/);
  });
});

// ── Проводка: настоящий GET крона ────────────────────────────────────────

const tgSend = vi.fn(async (_source: string, _text: string) => ({ ok: true as const }));

vi.mock('@/lib/notifications/tg-send', () => ({ tgSend: (s: string, t: string) => tgSend(s, t) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } }));
vi.mock('@/lib/agents/cron-lease', () => ({
  claimCronWindow: vi.fn(async () => ({ kind: 'claimed' })),
  shouldRun: () => true,
  leaseSkipBody: () => ({ skipped: true }),
}));
vi.mock('@/lib/agents/cron-heartbeat', () => ({ recordCronRun: vi.fn() }));
vi.mock('@/lib/agents/memory/agent-memory', () => ({
  agentMemory: { get: vi.fn(async () => null), remember: vi.fn(async () => undefined) },
}));
vi.mock('@/lib/agents/scout-digest', () => ({ SKIP_REASON_LABELS: {} }));
vi.mock('@/lib/crm/events', () => ({ recordSourceEventQuietly: vi.fn(), statusChangeTitle: () => '' }));
vi.mock('@/lib/eco/ledger', () => ({ checkInvariant: vi.fn(async () => ({ ok: true, sum: 0, accounts: 0, circulating: 0 })) }));
vi.mock('@/lib/telegram/bot-username', () => ({
  resolveTelegramBotUsername: vi.fn(async () => ({ username: 'kuzmichai_bot', source: 'getMe' })),
  botUsernameIssue: () => null,
}));
vi.mock('@/lib/ai/provider-config', () => ({ getTimewebAgents: () => ({}) }));
vi.mock('@/lib/ai/providers', () => {
  const alive = vi.fn(async () => 'ок');
  return {
    callAnthropic: alive, callOpenrouter: alive, callDeepSeek: alive, callFugu: alive, callQwen: alive,
    diagnosticSaysAlive: (s: number | null | undefined) => typeof s === 'number' && s >= 200 && s < 300,
    isAcceptedOpenRouterGeoBlock: () => false,
    isAcceptedAnthropicFromProd: () => false,
    probeOpenRouterKeyStatus: vi.fn(async () => null),
    probeQwenKeyStatus: vi.fn(async () => null),
    probeQwenRegions: vi.fn(async () => null),
    qwenRefusalKind: () => null,
    probeDeepSeekKeyStatus: vi.fn(async () => null),
    probeAnthropicKeyStatus: vi.fn(async () => null),
    probeTimewebAgentStatus: vi.fn(async () => null),
    explainDeepSeekFailure: () => '', explainAnthropicFailure: () => '', explainQwenFailure: () => '', explainOpenRouterFailure: () => '',
  };
});

describe('настоящий GET /api/cron/health', () => {
  const envBefore = { ...process.env };

  beforeEach(() => {
    tgSend.mockClear();
    process.env.CRON_SECRET = 'cron-test';
    for (const k of ['DASHSCOPE_API_KEY', 'ANTHROPIC_API_KEY', 'FUGU_API_KEY', 'MIGRATIONS_STARTUP_STATE']) delete process.env[k];
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...envBefore };
  });

  async function runHealth(): Promise<{ body: Record<string, unknown>; sent: string }> {
    const { GET } = await import('@/app/api/cron/health/route');
    const res = await GET(new NextRequest('https://vedarai.ru/api/cron/health', { headers: { authorization: 'Bearer cron-test' } }));
    const body = await res.json() as Record<string, unknown>;
    return { body, sent: tgSend.mock.calls.map(([, text]) => text).join('\n---\n') };
  }

  it('накат упал — CRIT в Telegram с файлом и SQLSTATE, состояние в ответе', async () => {
    process.env.MIGRATIONS_STARTUP_STATE = FAILED;
    const { body, sent } = await runHealth();
    expect(sent).toMatch(/CRIT: Схема БД отстаёт от кода: при старте контейнера/);
    expect(sent).toContain('1300_tour_access.sql');
    expect(sent).toContain('SQLSTATE 42703');
    expect(sent).not.toContain('914');
    expect(body.ok).toBe(false);
    expect(body.migrations).toMatchObject({ state: 'failed', file: '1300_tour_access.sql', sqlstate: '42703' });
  });

  it('состояние не записано — WARN «неизвестен», не молчание и не CRIT', async () => {
    const { body, sent } = await runHealth();
    expect(sent).toMatch(/WARN: Исход наката миграций при старте контейнера неизвестен \(not_recorded\)/);
    expect(sent).not.toMatch(/Схема БД отстаёт/);
    expect(body.migrations).toMatchObject({ state: 'unknown', reason: 'not_recorded' });
  });

  // Соседняя проводка в том же GET (аудит 15.10, A21): память процесса и
  // модель поиска по смыслу лежат в теле, которое cron-health.yml печатает
  // каждый час, — ряд rss_mb для решения о модели в апреле.
  it('тело несёт память процесса и состояние модели поиска по смыслу, с причиной отказа', async () => {
    delete process.env.SEMANTIC_SEARCH;
    const { markModelLoadFailed } = await import('@/lib/ai/semantic-search-state');
    markModelLoadFailed(new Error('Could not load sharp'), 900);
    try {
      const { body } = await runHealth();
      const mem = body.process_memory as Record<string, unknown>;
      expect(typeof mem.rss_mb).toBe('number');
      expect(mem.rss_mb as number).toBeGreaterThan(0);
      expect(typeof mem.heap_mb).toBe('number');
      expect(body.semantic_search).toMatchObject({ enabled: true, state: 'load_failed', error: 'Could not load sharp', load_ms: 900 });
    } finally {
      delete (globalThis as Record<symbol, unknown>)[Symbol.for('vedar.embeddingModel')];
    }
  });

  it('накат чистый — о миграциях ни слова', async () => {
    process.env.MIGRATIONS_STARTUP_STATE = JSON.stringify({ state: 'ok', reason: 'applied', file: null, sqlstate: null, failed_count: 0, at: AT });
    const { body, sent } = await runHealth();
    expect(sent).not.toMatch(/наката|Схема БД/);
    expect(body.migrations).toMatchObject({ state: 'ok' });
  });
});
