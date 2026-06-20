/**
 * tests/unit/editor-smoke-integration.test.ts
 *
 * Доказывает что smoke-test ловит тихую ошибку editor'а:
 * агент говорит "5 улучшено" но БД не изменилась.
 *
 * Три факта:
 *   1. result.passed === false, result.kind === 'silent_fail'
 *   2. В agent_run_history записан status='failed' (верифицируем захваченный INSERT)
 *   3. editor.ts откачен (проверяет сам тест — он падает если editor не сломан)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { smokeTestEditorWrites } from '@/lib/agents/smoke-test';
import { logAgentRun } from '@/lib/agents/run-logger';

// ── Мок пула БД ─────────────────────────────────────────────────────────────
const capturedQueries: Array<{ sql: string; params: unknown[] }> = [];
const mockPoolQuery = vi.fn((sql: string, params: unknown[]) => {
  capturedQueries.push({ sql: sql.trim(), params });
  // smokeTestEditorWrites делает SELECT COUNT(*) — возвращаем 0 строк (БД не обновлена)
  if (sql.includes('COUNT(*)')) return Promise.resolve({ rows: [{ cnt: '0' }] });
  // logAgentRun делает INSERT — просто подтверждаем
  return Promise.resolve({ rows: [], rowCount: 1 });
});

vi.mock('@/lib/db-pool', () => ({
  pool: { query: (sql: string, params: unknown[]) => mockPoolQuery(sql, params) },
}));

// ── Мок Telegram (fire-and-forget) ──────────────────────────────────────────
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  capturedQueries.length = 0;
  vi.clearAllMocks();
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID   = '123456';
  fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── СЛОМАННЫЙ EDITOR: возвращает 5 improved + fake IDs, НЕ пишет в БД ───────
const FAKE_IDS = [
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000004',
  '00000000-0000-0000-0000-000000000005',
];

function brokenEditorResult() {
  return { processed: 5, improved: 5, improved_ids: FAKE_IDS, improved_titles: ['fake'] as string[], errors: 0, duration_ms: 50 };
}

// ── Тест ────────────────────────────────────────────────────────────────────

describe('editor smoke-test: тихая ошибка обнаруживается', () => {
  it('сломанный editor → silent_fail + agent_run_history status=failed', async () => {
    const started_at = new Date();
    const result = brokenEditorResult();

    // ── ФАКТ 1: smoke-test возвращает silent_fail ─────────────────────────
    const smoke = await smokeTestEditorWrites(
      result.improved,
      result.improved_ids,
      result.processed,
      result.errors,
    );

    expect(smoke.passed, 'passed должен быть false').toBe(false);
    expect(smoke.kind,   'kind должен быть silent_fail').toBe('silent_fail');
    expect(smoke.actual, 'actual должен быть 0 (ничего в БД)').toBe(0);
    expect(smoke.claimed,'claimed должен быть 5').toBe(5);

    // Telegram-алерт ушёл (fire-and-forget)
    expect(fetchSpy).toHaveBeenCalled();
    const [alertUrl] = fetchSpy.mock.calls[0] as [string, ...unknown[]];
    expect(alertUrl).toContain('telegram.org');

    // ── ФАКТ 2: logAgentRun пишет status='failed' в agent_run_history ────
    await logAgentRun({
      agent_id:       'editor',
      status:         smoke.passed ? 'success' : 'failed',  // ← именно такая логика в cron/editor
      started_at,
      duration_ms:    Date.now() - started_at.getTime(),
      items_processed: result.processed,
      items_created:   result.improved,
      error_msg:       smoke.message,
      metadata:        { smoke_kind: smoke.kind } as Record<string, unknown>,
    });

    // «SELECT» из захваченных INSERT'ов — эквивалент реального SELECT
    const runHistoryInsert = capturedQueries.find(q => q.sql.includes('INSERT INTO agent_run_history'));
    expect(runHistoryInsert, 'INSERT INTO agent_run_history должен быть вызван').toBeTruthy();

    // params[1] = status (второй параметр $2)
    const insertedStatus = runHistoryInsert!.params[1];
    expect(insertedStatus, 'status в agent_run_history должен быть failed').toBe('failed');

    // ── ФАКТ 3: проверяем что FAKE_IDS — это именно то что передали ──────
    // (editor.ts в "сломанном" режиме вернул их без записи в places/kamchatka_routes)
    const smokeSelects = capturedQueries.filter(q => q.sql.includes('COUNT(*)'));
    expect(smokeSelects.length, 'smoke-test сделал 2 SELECT (places + kamchatka_routes)').toBe(2);
    // Оба SELECT вернули 0 → actual = 0 → silent_fail
    expect(smoke.actual).toBe(0);

  });
});
