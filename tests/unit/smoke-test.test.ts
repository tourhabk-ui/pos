import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { smokeTestEditorWrites } from '@/lib/agents/smoke-test';

const mockPoolQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}));

const FAKE_IDS = [
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
];

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  // sendTgAlertAsync guards on token+chatId before calling fetch — provide them
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = '123456';
  fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
});

describe('smokeTestEditorWrites', () => {
  it('provocation: agent claims 5 improved but DB has 0 written → silent_fail + Telegram alert', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ written: '0', goal: '0' }] });

    const result = await smokeTestEditorWrites(5, FAKE_IDS, 5, 0);

    expect(result.passed).toBe(false);
    expect(result.kind).toBe('silent_fail');
    expect(result.actual).toBe(0);
    expect(result.claimed).toBe(5);
    // Telegram must fire (fire-and-forget, but fetch was called)
    expect(fetchSpy).toHaveBeenCalled();
    const [url] = fetchSpy.mock.calls[0] as [string, ...unknown[]];
    expect(url).toContain('telegram.org');
  });

  it('tamper-proof: rows written but below the 300-char contract → under_spec warning + Telegram', async () => {
    // 3+3 written, but 0 meet the ≥300 goal → gaming with filler is caught, not passed as ok
    mockPoolQuery.mockResolvedValue({ rows: [{ written: '3', goal: '0' }] });

    const result = await smokeTestEditorWrites(5, FAKE_IDS, 5, 0);

    expect(result.passed).toBe(true);
    expect(result.kind).toBe('under_spec');
    expect(result.actual).toBe(6); // 3 places + 3 routes written
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('honest zero: processed=0 → zero_processed, no Telegram', async () => {
    const result = await smokeTestEditorWrites(0, [], 0, 0);

    expect(result.passed).toBe(true);
    expect(result.verdict).toBe('passed');
    expect(result.kind).toBe('zero_processed');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Прежде здесь стояло expect(result.passed).toBe(true) — тест закреплял
  // находку аудита 08.09: прогон, где обработано 5 и улучшено 0, уходил в
  // agent_run_history со статусом 'success'.
  it('all errors: processed=5 but improved=0 → провал прогона + Telegram', async () => {
    const result = await smokeTestEditorWrites(0, [], 5, 5);

    expect(result.passed).toBe(false);
    expect(result.verdict).toBe('failed');
    expect(result.kind).toBe('all_errors');
    expect(fetchSpy).toHaveBeenCalled();
    const [url] = fetchSpy.mock.calls[0] as [string, ...unknown[]];
    expect(url).toContain('telegram.org');
  });

  it('ok: agent claims 5, DB confirms 3+3=6 rows meeting the ≥300 contract → passed + kind ok', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ written: '3', goal: '3' }] });

    const result = await smokeTestEditorWrites(5, FAKE_IDS, 5, 0);

    expect(result.passed).toBe(true);
    expect(result.kind).toBe('ok');
    expect(result.actual).toBe(6); // 3 from places + 3 from kamchatka_routes
    expect(result.claimed).toBe(5);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * Третий исход дымовой проверки — находка аудита 08.09.
 *
 * `passed` было булевым, и `true` возвращалось при отказе БД, при
 * непроверяемом заявлении без ID и при полном провале генерации. Дальше в
 * `app/api/cron/editor/route.ts` стояло `status: smoke.passed ? 'success' :
 * 'failed'`, и все три случая записывались в историю прогонов УСПЕХОМ — а та
 * же история кормит проверки Watchdog. Сломанный Editor выглядел работающим
 * на всём пути от базы до сторожа.
 */
describe('дымовая проверка Editor: три исхода, а не два', () => {
  it('нет ID при заявленных улучшениях — «не знаю», не «прошло»', async () => {
    const result = await smokeTestEditorWrites(7, [], 7, 0);
    expect(result.verdict).toBe('unknown');
    expect(result.kind).toBe('skip');
    expect(result.passed).toBe(false);
    expect(result.message).toContain('проверить заявление нечем');
  });

  it('роут различает три исхода, а не булево', () => {
    const ROUTE = readFileSync('app/api/cron/editor/route.ts', 'utf8');
    expect(ROUTE).toMatch(/smoke\.verdict === 'passed' \? 'success'/);
    expect(ROUTE).toMatch(/smoke\.verdict === 'unknown' \? 'partial'/);
    expect(ROUTE).not.toMatch(/status: smoke\.passed \?/);
  });

  it('отказ базы — «не проверено», и он попадает в лог', () => {
    const SRC = readFileSync('lib/agents/smoke-test.ts', 'utf8');
    expect(SRC).toMatch(/verdict: 'unknown', kind: 'db_error'/);
    expect(SRC).toContain("logSwallowedFailure('smoke-test'");
    // Прежняя форма — отказ базы как успех — запрещена как КОД.
    expect(SRC).not.toMatch(/passed: true, kind: 'db_error'/);
  });

  it('частичная запись больше не считается полным успехом', () => {
    const SRC = readFileSync('lib/agents/smoke-test.ts', 'utf8');
    expect(SRC).toMatch(/if \(written < ids\.length\)/);
    expect(SRC).toMatch(/if \(actual < claimed\)/);
    expect(SRC).toContain("kind: 'partial_write'");
  });
});
