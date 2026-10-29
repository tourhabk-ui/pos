/**
 * Сторож двери крона напоминаний (CRM 1в-2, #2325): секрет до любого
 * действия, и исход прогона не выдаёт «не смог» за «хорошо» (§4.0) —
 * должники есть, а не обработан ни один — 502 и failed в журнале крона.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const run = vi.fn();
const runInbox = vi.fn();
const runDigest = vi.fn();
const recordCronRun = vi.fn();
vi.mock('@/lib/crm/reminders', () => ({ runTaskReminders: (...a: unknown[]) => run(...a) }));
vi.mock('@/lib/crm/inbox-reminders', () => ({ runInboxReminders: (...a: unknown[]) => runInbox(...a) }));
vi.mock('@/lib/chat-cabinet/digest', () => ({ runMorningDigest: (...a: unknown[]) => runDigest(...a) }));
vi.mock('@/lib/agents/cron-heartbeat', () => ({ recordCronRun: (...a: unknown[]) => recordCronRun(...a) }));

const { GET } = await import('@/app/api/cron/crm-reminders/route');

describe('GET /api/cron/crm-reminders', () => {
  const call = (auth = 'Bearer s3cret') =>
    GET(new Request('http://localhost/api/cron/crm-reminders', { headers: { authorization: auth } }));
  const base = {
    quiet: false, due: 0, partners: 0, sent_max: 0, sent_stub: 0, unreachable: 0, failed: 0, reach_unknown: 0,
    team_only: 0, team_sent_max: 0, team_sent_stub: 0, team_unknown: 0, truncated: false,
  };
  const inboxBase = { quiet: false, due: 0, partners: 0, sent_max: 0, sent_stub: 0, unreachable: 0, failed: 0, reach_unknown: 0, failed_kinds: [] };
  const digestBase = {
    window: false, candidates: 0, sent_max: 0, sent_tg: 0, sent_stub: 0, empty: 0, unreachable: 0,
    failed: 0, read_failed: 0, query_failed: false, truncated: false, done_today: null,
  };

  beforeEach(() => {
    process.env.CRON_SECRET = 's3cret';
    run.mockReset();
    runInbox.mockReset();
    runInbox.mockResolvedValue(inboxBase);
    runDigest.mockReset();
    runDigest.mockResolvedValue(digestBase);
    recordCronRun.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('без секрета — 401 и ни одного прогона', async () => {
    expect((await call('Bearer wrong')).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it('напоминать некому или ночь — 200', async () => {
    run.mockResolvedValueOnce(base);
    expect((await call()).status).toBe(200);
    run.mockResolvedValueOnce({ ...base, quiet: true });
    expect((await call()).status).toBe(200);
  });

  it('должники есть, не обработан ни один — 502; хоть один обработан — 200', async () => {
    run.mockResolvedValueOnce({ ...base, due: 3, partners: 2, failed: 1, reach_unknown: 1 });
    expect((await call()).status).toBe(502);
    expect(recordCronRun.mock.calls[0][2]).toBe('failed');
    run.mockResolvedValueOnce({ ...base, due: 3, partners: 2, failed: 1, sent_max: 1 });
    expect((await call()).status).toBe(200);
  });

  it('входящие (1г-2): не обработан ни один партнёр или вид не прочитался — 502; задачи при этом прогнаны', async () => {
    run.mockResolvedValue(base);
    runInbox.mockResolvedValueOnce({ ...inboxBase, due: 2, partners: 1, failed: 1 });
    let r = await call();
    expect(r.status).toBe(502);
    expect((await r.json()).error).toMatch(/входящие: не обработан ни один партнёр из 1/);
    runInbox.mockResolvedValueOnce({ ...inboxBase, failed_kinds: ['gear_rental'] });
    r = await call();
    expect(r.status).toBe(502);
    expect((await r.json()).error).toMatch(/входящие не прочитались: gear_rental/);
    expect(recordCronRun.mock.calls.every((c) => c[2] === 'failed')).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('оба прогона прошли — 200, в журнал идут доставки обоих', async () => {
    run.mockResolvedValueOnce({ ...base, sent_max: 1 });
    runInbox.mockResolvedValueOnce({ ...inboxBase, due: 3, partners: 2, sent_max: 1, sent_stub: 1 });
    const r = await call();
    expect(r.status).toBe(200);
    expect((await r.json()).inbox.sent_stub).toBe(1);
    expect(recordCronRun).toHaveBeenCalledWith('crm-reminders', expect.any(Number), 'success', { items: 3 });
  });

  it('у кабинета канала нет, а менеджерам дошло (CRM 2г) — партнёр обработан, 200; в журнале — доставка', async () => {
    run.mockResolvedValueOnce({ ...base, due: 2, partners: 2, failed: 1, team_only: 1, team_sent_max: 1 });
    const r = await call();
    expect(r.status).toBe(200);
    expect(recordCronRun).toHaveBeenCalledWith('crm-reminders', expect.any(Number), 'success', { items: 1 });
  });

  it('утренняя сводка (30.10): ни один кабинет не обработан или список не прочитался — 502; доставки — в журнал', async () => {
    run.mockResolvedValue(base);
    runDigest.mockResolvedValueOnce({ ...digestBase, window: true, candidates: 2, failed: 1, read_failed: 1 });
    let r = await call();
    expect(r.status).toBe(502);
    expect((await r.json()).error).toMatch(/сводка: не обработан ни один кабинет из 2/);
    runDigest.mockResolvedValueOnce({ ...digestBase, window: true, query_failed: true });
    r = await call();
    expect(r.status).toBe(502);
    expect((await r.json()).error).toMatch(/сводка: список кабинетов не прочитался/);
    // Хоть один обработан (даже «ждать нечего») — прогон не красный.
    runDigest.mockResolvedValueOnce({ ...digestBase, window: true, candidates: 3, failed: 1, empty: 1, sent_max: 1 });
    r = await call();
    expect(r.status).toBe(200);
    expect((await r.json()).digest.sent_max).toBe(1);
    expect(recordCronRun).toHaveBeenLastCalledWith('crm-reminders', expect.any(Number), 'success', { items: 1 });
  });

  it('сводка: в прогоне остался один недоступный чат, а сегодня другим уже дошло — 200; не дошло никому или счёт не прочитан — 502', async () => {
    run.mockResolvedValue(base);
    runDigest.mockResolvedValueOnce({ ...digestBase, window: true, candidates: 1, failed: 1, done_today: 4 });
    expect((await call()).status).toBe(200);
    runDigest.mockResolvedValueOnce({ ...digestBase, window: true, candidates: 1, failed: 1, done_today: 0 });
    expect((await call()).status).toBe(502);
    runDigest.mockResolvedValueOnce({ ...digestBase, window: true, candidates: 1, failed: 1, done_today: null });
    expect((await call()).status).toBe(502);
  });

  it('отказ базы — 500, в ответе нет текста ошибки базы', async () => {
    run.mockRejectedValueOnce(Object.assign(new Error('relation "crm_tasks" does not exist'), { code: '42P01' }));
    const r = await call();
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toMatch(/relation/);
  });
});
