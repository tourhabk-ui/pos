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

const { run, record, census } = vi.hoisted(() => ({ run: vi.fn(), record: vi.fn(), census: vi.fn() }));
vi.mock('@/lib/mcp/request-notify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mcp/request-notify')>()),
  runRequestNotify: run,
  readNotifyCensus: census,
}));
vi.mock('@/lib/agents/cron-heartbeat', () => ({ recordCronRun: record }));

import { GET } from '@/app/api/cron/agent-request-notify/route';
import { CRON_REGISTRY, CRON_IDLE_MEANING } from '@/lib/agents/cron-registry';
import { CRON_CAPABILITIES } from '@/lib/agents/cron-capability-registry';
import { SKIP_REASON_LABELS } from '@/lib/agents/scout-skip-reasons';
import { findFruitlessCrons, formatFruitlessCrons } from '@/lib/agents/cron-fruitless';

const authed = () => new Request('https://vedarai.ru/api/cron/agent-request-notify', { headers: { authorization: 'Bearer cron-test' } });
const base = { sqlstate: null, subscriptions_live: 1, checked: 1, changed: 1, baseline_unknown: 0, due: 1, delivered: 1, receiver_failed: {}, deferred: {}, disabled: {}, deleted_after_retention: 0, reset_reverted: 0, missing_view: 0, record_failed: 0, stall: null, duration_ms: 5 };

beforeEach(() => {
  run.mockReset();
  record.mockReset();
  census.mockReset();
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

  // Ревью 29.10: молчит наша сторона — ответ 200 (сердцевину чужими отказами
  // не красим), но прогон partial с причиной: серию таких называет Watchdog.
  it('молчание сети — 200, но прогон partial с причиной notify_stalled и числами без хостов', async () => {
    run.mockResolvedValue({ ...base, status: 'ok', delivered: 0, stall: { hosts: 2, minutes: 95 } });
    const res = await GET(authed());
    expect(res.status).toBe(200);
    expect(record).toHaveBeenCalledWith('agent-request-notify', expect.any(Number), 'partial', {
      items: 0,
      metadata: { skip_reason: 'notify_stalled', empty_reasons: ['сетевые отказы у приёмников, принимавших раньше: 2; доставок нет 95 мин'] },
    });
    expect(SKIP_REASON_LABELS.notify_stalled).toMatch(/не различить/);
  });

  it('серия прогонов partial доходит до тревоги «крон идёт, результата нет» с причиной словами', () => {
    const entry = CRON_REGISTRY.find((e) => e.key === 'agent-request-notify')!;
    const now = Date.parse('2027-07-01T12:00:00Z');
    const rows = [0, 30, 60].map((m) => ({
      agent_id: 'agent-request-notify', status: 'partial', ended_at: new Date(now - m * 60_000).toISOString(),
      skip_reason: 'notify_stalled', detail: 'сетевые отказы у приёмников, принимавших раньше: 2; доставок нет 95 мин',
    }));
    const found = findFruitlessCrons([entry], rows, now);
    expect(found).toHaveLength(1);
    expect(formatFruitlessCrons(found)).toContain(SKIP_REASON_LABELS.notify_stalled);
  });

  it('разбор подписки по номеру: без прогона; 400 на чужую форму, 404 — нет такой, 200 — коды и время', async () => {
    const bad = await GET(new Request('https://vedarai.ru/api/cron/agent-request-notify?ref=../../etc', { headers: { authorization: 'Bearer cron-test' } }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/^ref: /);
    census.mockResolvedValueOnce(null);
    const missing = await GET(new Request('https://vedarai.ru/api/cron/agent-request-notify?ref=nr_AAAAAAAAAAAAAAAAAAAAAA', { headers: { authorization: 'Bearer cron-test' } }));
    expect(missing.status).toBe(404);
    census.mockResolvedValueOnce({ ref: 'nr_AAAAAAAAAAAAAAAAAAAAAA', active: false, disabled_reason: 'rejected', last_error: 'http_404' });
    const ok = await GET(new Request('https://vedarai.ru/api/cron/agent-request-notify?ref=nr_AAAAAAAAAAAAAAAAAAAAAA', { headers: { authorization: 'Bearer cron-test' } }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).subscription).toMatchObject({ disabled_reason: 'rejected', last_error: 'http_404' });
    census.mockRejectedValueOnce(Object.assign(new Error('relation "agent_request_notify" does not exist'), { code: '42P01' }));
    const down = await GET(new Request('https://vedarai.ru/api/cron/agent-request-notify?ref=nr_AAAAAAAAAAAAAAAAAAAAAA', { headers: { authorization: 'Bearer cron-test' } }));
    expect(down.status).toBe(500);
    const body = await down.text();
    expect(body).toContain('42P01');
    expect(body).not.toMatch(/relation/);
    expect(run).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('реестр: каждые 30 минут в сердцевине, ноль доставок — норма, возможности объявлены', () => {
    const entry = CRON_REGISTRY.find((e) => e.key === 'agent-request-notify')!;
    expect(entry).toMatchObject({ workflow: 'cron-safety-heartbeat.yml', everyMin: 30, tier: 'ops', endpoint: 'agent-request-notify' });
    expect(CRON_IDLE_MEANING['agent-request-notify']).toBe('normal');
    expect(CRON_CAPABILITIES['agent-request-notify']).toEqual(['db_read', 'db_write', 'net_out']);
  });
});
