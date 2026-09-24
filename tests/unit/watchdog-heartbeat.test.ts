/**
 * Внешний сторож Watchdog (healthchecks.io, 24.09): связка целиком —
 * производитель (роут шлёт сигнал), исходы без глушения и объявление env.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePingUrl, pingHeartbeat, watchdogSignal, HEALTHCHECKS_ENV } from '@/lib/agents/heartbeat-ping';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const URL_OK = 'https://hc-ping.com/0f4a1c2e-1111-2222-3333-444455556666';

function fakeFetch(status: number, seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    return new Response('OK', { status });
  }) as typeof fetch;
}

describe('адрес пинга', () => {
  it('пусто — не настроено, а не ошибка', () => {
    expect(parsePingUrl(undefined)).toBeNull();
    expect(parsePingUrl('  ')).toBeNull();
  });

  it('чужой хост, http и адрес без проверки отвергаются', () => {
    expect(parsePingUrl('https://evil.example/x')).toHaveProperty('error');
    expect(parsePingUrl('http://hc-ping.com/abc')).toHaveProperty('error');
    expect(parsePingUrl('https://hc-ping.com/')).toHaveProperty('error');
    expect(parsePingUrl(URL_OK)).toBeInstanceOf(URL);
  });
});

describe('какой сигнал слать', () => {
  it('одна-две невыполненные проверки — ok, половина и больше — fail', () => {
    expect(watchdogSignal(20, 0)).toBe('ok');
    expect(watchdogSignal(20, 2)).toBe('ok');
    expect(watchdogSignal(20, 10)).toBe('fail');
    expect(watchdogSignal(20, 20)).toBe('fail');
    expect(watchdogSignal(0, 0)).toBe('fail');
  });
});

describe('исходы отправки — ни один не молчит (§4.0)', () => {
  it('нет адреса — not_configured, в сеть не ходим', async () => {
    const seen: string[] = [];
    const r = await pingHeartbeat('ok', 's', { env: {}, fetchImpl: fakeFetch(200, seen) });
    expect(r).toEqual({ state: 'not_configured' });
    expect(seen).toEqual([]);
  });

  it('кривой адрес — misconfigured, в сеть не ходим', async () => {
    const seen: string[] = [];
    const r = await pingHeartbeat('ok', 's', { env: { [HEALTHCHECKS_ENV]: 'https://evil.example/x' }, fetchImpl: fakeFetch(200, seen) });
    expect(r.state).toBe('misconfigured');
    expect(seen).toEqual([]);
  });

  it('ok — на сам адрес, fail — на /fail', async () => {
    const seen: string[] = [];
    const env = { [HEALTHCHECKS_ENV]: URL_OK };
    expect(await pingHeartbeat('ok', 's', { env, fetchImpl: fakeFetch(200, seen) })).toEqual({ state: 'sent', signal: 'ok' });
    expect(await pingHeartbeat('fail', 's', { env, fetchImpl: fakeFetch(200, seen) })).toEqual({ state: 'sent', signal: 'fail' });
    expect(seen).toEqual([URL_OK, `${URL_OK}/fail`]);
  });

  it('не 2xx и сетевой отказ — failed с причиной', async () => {
    const env = { [HEALTHCHECKS_ENV]: URL_OK };
    const r1 = await pingHeartbeat('ok', 's', { env, fetchImpl: fakeFetch(404) });
    expect(r1).toMatchObject({ state: 'failed', reason: 'HTTP 404' });
    const boom = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const r2 = await pingHeartbeat('ok', 's', { env, fetchImpl: boom });
    expect(r2).toMatchObject({ state: 'failed' });
    expect((r2 as { reason: string }).reason).toMatch(/fetch failed/);
  });
});

describe('связка: производитель и объявление', () => {
  const ROUTE = read('app/api/cron/watchdog/route.ts');

  it('роут Watchdog шлёт сигнал и после прогона, и при падении, с исходом в ответе', () => {
    expect(ROUTE).toMatch(/pingHeartbeat\(\s*watchdogSignal\(result\.checks\.total, failedChecks\)/);
    expect(ROUTE).toMatch(/pingHeartbeat\('fail'/);
    expect(ROUTE.match(/heartbeat \}\)|heartbeat \},/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('env объявлен в .env.example без значения', () => {
    expect(read('.env.example')).toMatch(/^HEALTHCHECKS_WATCHDOG_URL=\s+#/m);
  });
});
