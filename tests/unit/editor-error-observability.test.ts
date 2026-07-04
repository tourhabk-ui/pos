/**
 * tests/unit/editor-error-observability.test.ts
 *
 * Прод-инцидент «SMOKE WARN: Editor — обработано 30, улучшено 0 (ошибок: 30)»:
 * причина была недиагностируема, потому что EditorResult нёс только число errors,
 * а catch'и были пустыми. Эти тесты фиксируют контракт наблюдаемости:
 * runEditor различает generation_failed / db_update_failed и отдаёт
 * error_samples с конкретными причинами — они уходят в Telegram-алерт смоук-теста.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runEditor, generateRouteDescription, type RouteRow } from '@/lib/agents/editor';
import type { ExperimentTracker } from '@/lib/agents/learning/experiment-tracker';

// ── Моки провайдеров ─────────────────────────────────────────────────────────
const callAIFastMock = vi.fn<(...args: unknown[]) => Promise<string | null>>();
const callFuguMock = vi.fn<(...args: unknown[]) => Promise<string | null>>();

vi.mock('@/lib/ai/providers', () => ({
  callAIFast: (...args: unknown[]) => callAIFastMock(...args),
  callFugu: (...args: unknown[]) => callFuguMock(...args),
}));

// ── Мок пула БД ──────────────────────────────────────────────────────────────
const poolQueryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>();

vi.mock('@/lib/db-pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => poolQueryMock(sql, params) },
}));

// ── Мок трекера экспериментов ────────────────────────────────────────────────
// findOrCreate падает → runEditor идёт без эксперимента (generateRouteDescription
// берёт прямой путь callAIFast). Вариант B (Fugu) тестируем отдельно, передавая
// fake tracker прямо в generateRouteDescription.
vi.mock('@/lib/agents/learning/experiment-tracker', () => ({
  ExperimentTracker: class {
    async findOrCreate(): Promise<never> { throw new Error('experiment tracking disabled in test'); }
    pickVariant(): 'a' | 'b' { return 'a'; }
    async recordResult(): Promise<void> {}
    async calculateResults(): Promise<{ winner: null }> { return { winner: null }; }
    async updateStatus(): Promise<void> {}
  },
}));

const ROUTE: RouteRow = {
  id: '00000000-0000-0000-0000-000000000001',
  title: 'Вулкан Тестовый',
  description: null,
  category: 'vulkani',
};

const LONG_TEXT = 'Содержательное описание вулкана. '.repeat(15); // ~495 симв. >= 100

function mockDb(opts: { routes: RouteRow[]; updateError?: Error }) {
  poolQueryMock.mockImplementation((sql: string) => {
    if (sql.includes('SELECT id, title')) return Promise.resolve({ rows: opts.routes });
    if (sql.includes('UPDATE agent_route_knowledge')) {
      if (opts.updateError) return Promise.reject(opts.updateError);
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes('COUNT(*)')) return Promise.resolve({ rows: [{ cnt: '5' }] });
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.TELEGRAM_BOT_TOKEN; // tgSend — no-op в тестах
  delete process.env.TELEGRAM_CHAT_ID;
});

// ── runEditor: раздельные счётчики и причины ─────────────────────────────────

describe('runEditor: наблюдаемость ошибок', () => {
  it('генерация вернула null → generation_failed + sample с причиной', async () => {
    mockDb({ routes: [ROUTE] });
    callAIFastMock.mockResolvedValue(null);

    const result = await runEditor();

    expect(result.processed).toBe(1);
    expect(result.improved).toBe(0);
    expect(result.errors).toBe(1);
    expect(result.generation_failed).toBe(1);
    expect(result.db_update_failed).toBe(0);
    expect(result.error_samples).toHaveLength(1);
    expect(result.error_samples[0]).toContain('пустой ответ');
  });

  it('apology-заглушка waterfall (все провайдеры отказали) → generation_failed с внятной причиной', async () => {
    mockDb({ routes: [ROUTE] });
    // Ровно то, что возвращает callAIFast при отказе ВСЕХ fast-провайдеров
    callAIFastMock.mockResolvedValue('Сервис временно недоступен.');

    const result = await runEditor();

    expect(result.generation_failed).toBe(1);
    expect(result.error_samples[0]).toContain('короткий ответ 27 симв.');
    expect(result.error_samples[0]).toContain('fast-провайдеры отказали');
  });

  it('UPDATE бросает → db_update_failed + sample с названием маршрута и сообщением БД', async () => {
    mockDb({ routes: [ROUTE], updateError: new Error('column ot.duration_days does not exist') });
    callAIFastMock.mockResolvedValue(LONG_TEXT);

    const result = await runEditor();

    expect(result.generation_failed).toBe(0);
    expect(result.db_update_failed).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.error_samples[0]).toContain('db_update');
    expect(result.error_samples[0]).toContain('Вулкан Тестовый');
    expect(result.error_samples[0]).toContain('column ot.duration_days does not exist');
  });

  it('SELECT очереди бросает → errors=1 + sample db_select', async () => {
    poolQueryMock.mockRejectedValue(new Error('connection refused'));

    const result = await runEditor();

    expect(result.processed).toBe(0);
    expect(result.errors).toBe(1);
    expect(result.error_samples[0]).toContain('db_select');
    expect(result.error_samples[0]).toContain('connection refused');
  });

  it('успешный путь не регрессировал: improved++, samples пусты', async () => {
    mockDb({ routes: [ROUTE] });
    callAIFastMock.mockResolvedValue(LONG_TEXT);

    const result = await runEditor();

    expect(result.processed).toBe(1);
    expect(result.improved).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.generation_failed).toBe(0);
    expect(result.db_update_failed).toBe(0);
    expect(result.error_samples).toEqual([]);
    expect(result.improved_ids).toEqual([ROUTE.id]);
    expect(result.improved_titles).toEqual([ROUTE.title]);
  });

  it('error_samples дедуплицируются и ограничены 5', async () => {
    const routes = Array.from({ length: 8 }, (_, i) => ({ ...ROUTE, id: `00000000-0000-0000-0000-00000000000${i + 1}` }));
    mockDb({ routes });
    callAIFastMock.mockResolvedValue(null); // одна и та же причина у всех 8

    const result = await runEditor();

    expect(result.errors).toBe(8);
    expect(result.error_samples).toHaveLength(1); // дедуп: причина одинаковая
  });
});

// ── generateRouteDescription: вариант B (Fugu) ───────────────────────────────

describe('generateRouteDescription: причины провала варианта B (Fugu)', () => {
  function trackerWithVariant(variant: 'a' | 'b'): ExperimentTracker {
    return {
      pickVariant: () => variant,
      recordResult: vi.fn().mockResolvedValue(undefined),
    } as unknown as ExperimentTracker;
  }

  it('fugu null + fallback null → failReason называет обоих', async () => {
    callFuguMock.mockResolvedValue(null);
    callAIFastMock.mockResolvedValue(null);

    const outcome = await generateRouteDescription(ROUTE, 'exp-1', trackerWithVariant('b'));

    expect(outcome.text).toBeNull();
    expect(outcome.failReason).toContain('fugu: null');
    expect(outcome.failReason).toContain('fallback callAIFast');
    expect(outcome.failReason).toContain('пустой ответ');
  });

  it('fugu null, но fallback дал текст → успех без failReason', async () => {
    callFuguMock.mockResolvedValue(null);
    callAIFastMock.mockResolvedValue(LONG_TEXT);

    const outcome = await generateRouteDescription(ROUTE, 'exp-1', trackerWithVariant('b'));

    expect(outcome.text?.length).toBeGreaterThanOrEqual(100);
    expect(outcome.failReason).toBeUndefined();
  });

  it('fugu короткий ответ → failReason с длиной', async () => {
    callFuguMock.mockResolvedValue('Коротко.');

    const outcome = await generateRouteDescription(ROUTE, 'exp-1', trackerWithVariant('b'));

    expect(outcome.failReason).toContain('fugu: короткий ответ 8 симв.');
  });

  it('exception внутри варианта → failReason с сообщением и вариантом', async () => {
    callFuguMock.mockRejectedValue(new Error('fetch failed: ENOTFOUND api.sakana.ai'));

    const outcome = await generateRouteDescription(ROUTE, 'exp-1', trackerWithVariant('b'));

    expect(outcome.text).toBeNull();
    expect(outcome.failReason).toContain('exception (b)');
    expect(outcome.failReason).toContain('ENOTFOUND api.sakana.ai');
  });
});
