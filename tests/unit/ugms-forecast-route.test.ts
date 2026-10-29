// @vitest-environment node
/**
 * /api/cron/ugms-forecast — три исхода прогона вызовом роута: записано;
 * ничего не записано — 502, failed, здоровье источника error с причиной;
 * без секрета — 401 и ни похода, ни отметки. Отметка прогона — под ключом
 * реестра, счётчик работы — записанные блоки.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { UgmsSync } from '@/lib/weather/ugms-forecast';

const recordCronRun = vi.fn();
const recordSourceHealth = vi.fn(async () => {});
const syncUgmsForecast = vi.fn<() => Promise<UgmsSync>>();

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/lib/agents/cron-heartbeat', () => ({ recordCronRun: (...a: unknown[]) => recordCronRun(...a) }));
vi.mock('@/lib/agents/cron-lease', async (orig) => ({
  ...(await orig<typeof import('@/lib/agents/cron-lease')>()),
  claimCronWindow: async () => 'claimed',
}));
vi.mock('@/lib/services/safety/source-health', async (orig) => ({
  ...(await orig<typeof import('@/lib/services/safety/source-health')>()),
  recordSourceHealth: (...a: unknown[]) => recordSourceHealth(...a),
}));
vi.mock('@/lib/weather/ugms-forecast', async (orig) => ({
  ...(await orig<typeof import('@/lib/weather/ugms-forecast')>()),
  syncUgmsForecast: () => syncUgmsForecast(),
}));

process.env.CRON_SECRET = 'test-cron-secret';

async function call(secret = 'test-cron-secret') {
  const { GET } = await import('@/app/api/cron/ugms-forecast/route');
  const res = await GET(new NextRequest('http://localhost/api/cron/ugms-forecast', { headers: { authorization: `Bearer ${secret}` } }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

beforeEach(() => {
  recordCronRun.mockReset();
  recordSourceHealth.mockClear();
  syncUgmsForecast.mockReset();
});

describe('ugms-forecast', () => {
  it('без секрета — 401, ни похода, ни отметки', async () => {
    expect((await call('wrong')).status).toBe(401);
    expect(syncUgmsForecast).not.toHaveBeenCalled();
    expect(recordCronRun).not.toHaveBeenCalled();
  });

  it('записано — success со счётчиком, здоровье ok', async () => {
    syncUgmsForecast.mockResolvedValue({ ok: true, written: 7, pagesRead: 2, problems: [] });
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, written: 7 });
    expect(recordCronRun).toHaveBeenCalledWith('ugms-forecast', expect.any(Number), 'success', { items: 7 });
    expect(recordSourceHealth.mock.calls[0][1]).toMatchObject([{ key: 'ugms_forecast', status: 'ok', rawItems: 7, aliveBy: 'raw_items' }]);
  });

  it('одна страница не дошла — записано, что дошло; отказ назван в ответе и в логе', async () => {
    syncUgmsForecast.mockResolvedValue({ ok: true, written: 3, pagesRead: 1, problems: ['HTTP 503 https://kammeteo.ru/prognoz/prognozy2.php'] });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.problems).toEqual(['HTTP 503 https://kammeteo.ru/prognoz/prognozy2.php']);
    expect(err.mock.calls.some(([m]) => String(m).includes('часть страниц не прочитана'))).toBe(true);
    err.mockRestore();
  });

  it('ничего не записано — 502, failed, здоровье error с причиной', async () => {
    syncUgmsForecast.mockResolvedValue({ ok: false, written: 0, pagesRead: 0, problems: ['HTTP 403 https://kammeteo.ru/prognoz/prognozy1.php', 'day23: заголовок «ПРОГНОЗ НА …» не найден'] });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { status, body } = await call();
    expect(status).toBe(502);
    expect(body.success).toBe(false);
    expect(recordCronRun).toHaveBeenCalledWith('ugms-forecast', expect.any(Number), 'failed', { error: expect.stringContaining('HTTP 403') });
    expect(recordSourceHealth.mock.calls[0][1]).toMatchObject([{ key: 'ugms_forecast', status: 'error', rawItems: 0, error: expect.stringContaining('HTTP 403') }]);
    err.mockRestore();
  });
});
