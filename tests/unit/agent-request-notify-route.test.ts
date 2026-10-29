// @vitest-environment node
/**
 * GET /api/cron/agent-request-notify — три исхода прогона (§4.0) и отметка
 * под ключом реестра (29.10, уведомления агентам).
 *
 * Держит: без секрета — 401, без CRON_SECRET в окружении — 500; «хорошо» —
 * 200 и success; «не смог» (нет ENCRYPTION_KEY при живых подписках) — 502 и
 * failed; SQL упал — 500, failed, SQLSTATE; брошенное исключение — 500 без
 * текста ошибки. Тело ответа печатается в публичный лог Actions, поэтому в нём
 * нет ни текста ошибки, ни хоста.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { run, record } = vi.hoisted(() => ({ run: vi.fn(), record: vi.fn() }));
vi.mock('@/lib/mcp/request-notify', () => ({ runRequestNotify: run }));
vi.mock('@/lib/agents/cron-heartbeat', () => ({ recordCronRun: record }));

import { GET } from '@/app/api/cron/agent-request-notify/route';
import { CRON_REGISTRY, CRON_IDLE_MEANING } from '@/lib/agents/cron-registry';
import { CRON_CAPABILITIES } from '@/lib/agents/cron-capability-registry';

const authed = () => new Request('https://vedarai.ru/api/cron/agent-request-notify', { headers: { authorization: 'Bearer cron-test' } });
const base = { sqlstate: null, subscriptions_live: 1, checked: 1, changed: 1, baseline_unknown: 0, due: 1, delivered: 1, receiver_failed: {}, deferred: {}, disabled: {}, deleted_after_retention: 0, reset_reverted: 0, missing_view: 0, record_failed: 0, duration_ms: 5 };

beforeEach(() => {
  run.mockReset();
  record.mockReset();
  vi.stubEnv('CRON_SECRET', 'cron-test');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('agent-request-notify: исходы прогона', () => {
  it('без верного секрета — 401, прогона нет', async () => {
    const res = await GET(new Request('https://vedarai.ru/api/cron/agent-request-notify', { headers: { authorization: 'Bearer wrong' } }));
    expect(res.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it('«хорошо» — 200, success с числом доставок под ключом реестра', async () => {
    run.mockResolvedValue({ ...base, status: 'ok' });
    const res = await GET(authed());
    expect(res.status).toBe(200);
    expect(record).toHaveBeenCalledWith('agent-request-notify', expect.any(Number), 'success', { items: 1 });
    const entry = CRON_REGISTRY.find((e) => e.key === 'agent-request-notify');
    expect(entry?.agentId).toBe('agent-request-notify');
  });

  it('«не смог» (нет ENCRYPTION_KEY) — 502 и failed', async () => {
    run.mockResolvedValue({ ...base, status: 'no_encryption' });
    const res = await GET(authed());
    expect(res.status).toBe(502);
    expect(record).toHaveBeenCalledWith('agent-request-notify', expect.any(Number), 'failed', { error: 'no_encryption: ENCRYPTION_KEY не задан' });
  });

  it('SQL упал — 500, failed с SQLSTATE', async () => {
    run.mockResolvedValue({ ...base, status: 'db_error', sqlstate: '57P01' });
    const res = await GET(authed());
    expect(res.status).toBe(500);
    expect((await res.json()).sqlstate).toBe('57P01');
    expect(record).toHaveBeenCalledWith('agent-request-notify', expect.any(Number), 'failed', { error: 'db_error: SQLSTATE=57P01' });
  });

  it('исключение — 500 без текста ошибки (в нём бывает хост приёмника)', async () => {
    run.mockRejectedValue(new Error('getaddrinfo ENOTFOUND hooks.agent-example.ru'));
    const res = await GET(authed());
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toMatch(/hooks|ENOTFOUND/);
    expect(JSON.stringify(record.mock.calls)).not.toMatch(/hooks|ENOTFOUND/);
  });

  it('реестр: каждые 30 минут в сердцевине, ноль доставок — норма, возможности объявлены', () => {
    const entry = CRON_REGISTRY.find((e) => e.key === 'agent-request-notify')!;
    expect(entry).toMatchObject({ workflow: 'cron-safety-heartbeat.yml', everyMin: 30, tier: 'ops', endpoint: 'agent-request-notify' });
    expect(CRON_IDLE_MEANING['agent-request-notify']).toBe('normal');
    expect(CRON_CAPABILITIES['agent-request-notify']).toEqual(['db_read', 'db_write', 'net_out']);
  });
});
