// @vitest-environment node
/**
 * Роут чтения статусов парка: секрет, 502 на отказ чтения, «partial» с мерой
 * в журнале (сторож agent-runs-measured). Правила — park-route-status.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const run = vi.fn();
const logAgentRun = vi.fn();
vi.mock('@/lib/parks/park-route-status-run', () => ({ runParkStatusRead: (...a: unknown[]) => run(...a) }));
vi.mock('@/lib/agents/run-logger', () => ({ logAgentRun: (...a: unknown[]) => logAgentRun(...a) }));

describe('роут /api/cron/park-route-status', () => {
  const SECRET = 'park-status-secret';
  const req = (auth?: string) => new Request('https://vedarai.ru/api/cron/park-route-status',
    { headers: auth ? { authorization: `Bearer ${auth}` } : {} });

  beforeEach(() => { vi.clearAllMocks(); process.env.CRON_SECRET = SECRET; });

  it('без секрета — 401, чтения нет', async () => {
    const { GET } = await import('@/app/api/cron/park-route-status/route');
    expect((await GET(req() as never)).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
  it('страница не прочиталась — 502 и запись «failed» в журнале', async () => {
    run.mockResolvedValue({ outcome: 'fetch_failed', error: 'HTTP 503' });
    const { GET } = await import('@/app/api/cron/park-route-status/route');
    const res = await GET(req(SECRET) as never);
    expect(res.status).toBe(502);
    expect(logAgentRun).toHaveBeenCalledWith(expect.objectContaining({ agent_id: 'park-route-status', status: 'failed', items_processed: 0 }));
  });
  it('прочитано с несовпавшими — 200 и «partial» с мерой', async () => {
    run.mockResolvedValue({ outcome: 'read', parsed: 50, written: 49, open: [], not_in_table: ['x'], not_on_page: [], problems: [] });
    const { GET } = await import('@/app/api/cron/park-route-status/route');
    const res = await GET(req(SECRET) as never);
    expect(res.status).toBe(200);
    expect(logAgentRun).toHaveBeenCalledWith(expect.objectContaining({ status: 'partial', items_processed: 49, errors_count: 1 }));
  });
});
