// @vitest-environment node
/**
 * Watchdog называет причину своего «не успеха» — в журнале и во второй ноге.
 *
 * 02.09: детектор бесплодных кронов пометил самого Watchdog — «47 прогонов
 * подряд без результата, причина пропуска не записана». Причина была
 * (проверка падала на отсутствующей таблице), но в общий ключ `skip_reason`
 * она не попадала.
 *
 * 23.11: то же с доставкой. Тревога, которую Telegram не принял, писалась
 * зелёным прогоном; ответ роута говорил `success: true`.
 *
 * Судится вызовом обработчика: что уходит в журнал и что отвечает роут.
 * (До 23.11 этот файл сравнивал текст роута — и покраснел на верной правке.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const runWatchdogMock = vi.fn();
vi.mock('@/lib/agents/watchdog', () => ({ runWatchdog: () => runWatchdogMock() }));

const logAgentRunMock = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/agents/run-logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/run-logger')>()),
  logAgentRun: (p: unknown) => logAgentRunMock(p),
}));

const claimMock = vi.fn();
vi.mock('@/lib/agents/cron-lease', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/cron-lease')>()),
  claimCronWindow: (...a: unknown[]) => claimMock(...a),
}));

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQueryMock(...a) } }));

import { GET } from '@/app/api/cron/watchdog/route';

const call = () => GET(new Request('https://vedarai.ru/api/cron/watchdog', { headers: { Authorization: 'Bearer s3cret' } }));
const result = (over: Record<string, unknown> = {}) => ({
  alerts: [], checked_at: '2026-11-23T00:00:00Z', duration_ms: 5,
  delivery: { status: 'nothing_to_send' }, checks: { total: 28, failed: [] }, ...over,
});
const logged = () => logAgentRunMock.mock.calls.at(-1)?.[0] as {
  status: string; errors_count: number; error_msg?: string; metadata: { skip_reason: string | null };
};

beforeEach(() => {
  process.env.CRON_SECRET = 's3cret';
  runWatchdogMock.mockReset();
  logAgentRunMock.mockClear();
  claimMock.mockReset();
  claimMock.mockResolvedValue('claimed');
  poolQueryMock.mockReset();
});

describe('watchdog: причина «не успеха» доезжает до журнала', () => {
  it('проверки не выполнились — partial, в skip_reason их имена', async () => {
    runWatchdogMock.mockResolvedValue(result({
      delivery: { status: 'delivered' },
      checks: { total: 28, failed: [{ check: 'checkPendingTransferBookings', reason: 'relation does not exist' }] },
    }));
    const body = await (await call()).json() as { success: boolean };
    expect(logged().status).toBe('partial');
    expect(logged().metadata.skip_reason).toBe('unverified: checkPendingTransferBookings');
    expect(logged().error_msg).toContain('checkPendingTransferBookings');
    expect(body.success).toBe(false);
  });

  it('тревога не доставлена — failed, причина в журнале, роут не говорит «успех»', async () => {
    runWatchdogMock.mockResolvedValue(result({
      alerts: [{ type: 'sos_ignored', details: 'SOS' }],
      delivery: { status: 'failed', reason: 'Telegram ответил 403: bot was blocked' },
    }));
    const res = await call();
    const body = await res.json() as { success: boolean };
    expect(res.status).toBe(200);
    expect(body.success).toBe(false);
    expect(logged().status).toBe('failed');
    expect(logged().errors_count).toBe(1);
    expect(logged().error_msg).toContain('тревога не доставлена в Telegram: Telegram ответил 403');
    expect(logged().metadata.skip_reason).toContain('undelivered');
  });

  it('чистый прогон — success без причины', async () => {
    runWatchdogMock.mockResolvedValue(result());
    const body = await (await call()).json() as { success: boolean };
    expect(body.success).toBe(true);
    expect(logged().status).toBe('success');
    expect(logged().metadata.skip_reason).toBeNull();
  });
});

describe('watchdog: окно занято — вторая нога видит последний прогон', () => {
  it('отдаёт признаки последнего прогона без текста тревог', async () => {
    claimMock.mockResolvedValue('held');
    poolQueryMock.mockResolvedValue({ rows: [{ status: 'failed', age_min: 12, delivery: 'failed', reason: 'Telegram ответил 400' }] });
    const body = await (await call()).json() as { skipped: string; last_run: Record<string, unknown> };
    expect(body.skipped).toBe('lease_held');
    expect(body.last_run).toEqual({ status: 'failed', age_min: 12, delivery: 'failed', reason: 'Telegram ответил 400' });
    expect(runWatchdogMock).not.toHaveBeenCalled();
    // В запросе — только признаки доставки, не массив тревог.
    const sql = String(poolQueryMock.mock.calls[0]?.[0] ?? '');
    expect(sql).toContain("metadata->'delivery'");
    expect(sql).not.toContain("metadata->'alerts'");
  });

  it('журнал пуст — never; журнал не прочитался — unread, а не «всё в порядке»', async () => {
    claimMock.mockResolvedValue('held');
    poolQueryMock.mockResolvedValueOnce({ rows: [] });
    expect((await (await call()).json() as { last_run: unknown }).last_run).toEqual({ never: true });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    poolQueryMock.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '57P01' }));
    expect((await (await call()).json() as { last_run: unknown }).last_run).toEqual({ unread: true });
    expect(err.mock.calls.some((c) => String(c.join(' ')).includes('57P01'))).toBe(true);
    err.mockRestore();
  });
});
