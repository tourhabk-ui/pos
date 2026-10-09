/**
 * Сторож двери крона напоминаний (CRM 1в-2, #2325): секрет до любого
 * действия, и исход прогона не выдаёт «не смог» за «хорошо» (§4.0) —
 * должники есть, а не обработан ни один — 502 и failed в журнале крона.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const run = vi.fn();
const recordCronRun = vi.fn();
vi.mock('@/lib/crm/reminders', () => ({ runTaskReminders: (...a: unknown[]) => run(...a) }));
vi.mock('@/lib/agents/cron-heartbeat', () => ({ recordCronRun: (...a: unknown[]) => recordCronRun(...a) }));

const { GET } = await import('@/app/api/cron/crm-reminders/route');

describe('GET /api/cron/crm-reminders', () => {
  const call = (auth = 'Bearer s3cret') =>
    GET(new Request('http://localhost/api/cron/crm-reminders', { headers: { authorization: auth } }));
  const base = { quiet: false, due: 0, partners: 0, sent_max: 0, sent_stub: 0, unreachable: 0, failed: 0, reach_unknown: 0, truncated: false };

  beforeEach(() => {
    process.env.CRON_SECRET = 's3cret';
    run.mockReset();
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

  it('отказ базы — 500, в ответе нет текста ошибки базы', async () => {
    run.mockRejectedValueOnce(Object.assign(new Error('relation "crm_tasks" does not exist'), { code: '42P01' }));
    const r = await call();
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toMatch(/relation/);
  });
});
