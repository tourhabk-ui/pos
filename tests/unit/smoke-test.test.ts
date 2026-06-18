import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  it('provocation: agent claims 5 improved but DB has 0 → silent_fail + Telegram alert', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ cnt: '0' }] });

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

  it('honest zero: processed=0 → zero_processed, no Telegram', async () => {
    const result = await smokeTestEditorWrites(0, [], 0, 0);

    expect(result.passed).toBe(true);
    expect(result.kind).toBe('zero_processed');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('all errors: processed=5 but improved=0 → all_errors warning + Telegram', async () => {
    const result = await smokeTestEditorWrites(0, [], 5, 5);

    expect(result.passed).toBe(true);
    expect(result.kind).toBe('all_errors');
    expect(fetchSpy).toHaveBeenCalled();
    const [url] = fetchSpy.mock.calls[0] as [string, ...unknown[]];
    expect(url).toContain('telegram.org');
  });

  it('ok: agent claims 5, DB confirms 3+3=6 rows → passed + kind ok', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ cnt: '3' }] });

    const result = await smokeTestEditorWrites(5, FAKE_IDS, 5, 0);

    expect(result.passed).toBe(true);
    expect(result.kind).toBe('ok');
    expect(result.actual).toBe(6); // 3 from places + 3 from kamchatka_routes
    expect(result.claimed).toBe(5);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
