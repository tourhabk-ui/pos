// @vitest-environment node
/**
 * Приёмник ловушки ошибок браузера (POST /api/client-errors, 13.10) —
 * поведением с подменённым пулом: что ложится в строку (чистое сообщение,
 * путь без query, род устройства вместо User-Agent, отпечаток, метки своего
 * и бота), что отвергается (форма, частота), что говорит отказ базы.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const queries: Array<{ sql: string; params: unknown[] }> = [];
let failInsert: { code: string; message: string } | null = null;
vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (failInsert) throw Object.assign(new Error(failInsert.message), { code: failInsert.code });
      return { rows: [], rowCount: 1 };
    }),
  },
}));

import { POST, RATE_LIMIT } from '@/app/api/client-errors/route';
import { isPublicApiPath } from '@/lib/auth/public-api-routes';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function post(body: unknown, headers: Record<string, string> = {}, ip = '203.0.113.7') {
  return POST(new NextRequest('http://localhost/api/client-errors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip, 'user-agent': IPHONE, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
}

beforeEach(() => {
  queries.length = 0;
  failInsert = null;
  vi.stubEnv('CRON_SECRET', 'cron-test');
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('приём доклада', () => {
  it('204 и строка без ПД: сообщение вычищено, путь без query, устройство словом, отпечаток, время события', async () => {
    const res = await post({
      kind: 'error',
      message: "Cannot read properties of undefined (reading 'map') for ivan@example.com",
      stack: "TypeError: x\n    at TourGrid (https://vedarai.ru/_next/static/chunks/page.js?v=1:12:3)",
      path: '/catalog/tours/51?secret=abc#frag',
      online: true,
      occurred_at: '2026-10-13T10:00:00.000Z',
    }, {}, '203.0.113.10');
    expect(res.status).toBe(204);
    const ins = queries.find((q) => /INSERT INTO client_errors/.test(q.sql));
    expect(ins).toBeDefined();
    const [occurredAt, kind, message, stack, fingerprint, path, device, browser, online, , hash, isBot, isSelf] = ins!.params as unknown[];
    expect(occurredAt).toBe('2026-10-13T10:00:00.000Z');
    expect(kind).toBe('error');
    expect(message).not.toContain('ivan@example.com');
    expect(message).toContain("reading 'map'");
    expect(stack).toContain('/_next/static/chunks/page.js');
    expect(stack).not.toContain('?v=1');
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(path).toBe('/catalog/tours/51');
    expect(device).toBe('phone');
    expect(browser).toBe('safari');
    expect(online).toBe(true);
    expect(typeof hash).toBe('string');
    expect(String(hash)).not.toContain('203.0.113');
    expect(isBot).toBe(false);
    expect(isSelf).toBe(false);
    // Строка User-Agent целиком в параметры не попадает.
    expect(ins!.params.some((p) => typeof p === 'string' && p.includes('AppleWebKit'))).toBe(false);
  });

  it('свой заход (cookie vedar_self=1) и бот помечаются, не выбрасываются', async () => {
    await post({ kind: 'boundary', message: 'x', path: '/' }, { cookie: 'vedar_self=1' }, '203.0.113.11');
    await post({ kind: 'boundary', message: 'x', path: '/' }, { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }, '203.0.113.12');
    const rows = queries.filter((q) => /INSERT INTO client_errors/.test(q.sql));
    expect(rows).toHaveLength(2);
    expect(rows[0].params[12]).toBe(true);   // is_self
    expect(rows[1].params[11]).toBe(true);   // is_bot
  });

  it('неизвестная форма и не-JSON — 400 без записи', async () => {
    expect((await post({ kind: 'weird', message: 'x', path: '/' }, {}, '203.0.113.20')).status).toBe(400);
    expect((await post('{not json', {}, '203.0.113.21')).status).toBe(400);
    expect((await post({ kind: 'error', path: '/' }, {}, '203.0.113.22')).status).toBe(400);
    expect(queries.filter((q) => /INSERT/.test(q.sql))).toHaveLength(0);
  });

  it(`частота по IP: ${RATE_LIMIT.max} в минуту, дальше 429`, async () => {
    for (let i = 0; i < RATE_LIMIT.max; i += 1) {
      expect((await post({ kind: 'error', message: `e${i}`, path: '/' }, {}, '203.0.113.30')).status).toBe(204);
    }
    expect((await post({ kind: 'error', message: 'overflow', path: '/' }, {}, '203.0.113.30')).status).toBe(429);
    expect((await post({ kind: 'error', message: 'other ip', path: '/' }, {}, '203.0.113.31')).status).toBe(204);
  });

  it('отказ базы — 503 и строка в лог с SQLSTATE, не тихий 204', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    failInsert = { code: '42P01', message: 'relation "client_errors" does not exist' };
    const res = await post({ kind: 'error', message: 'x', path: '/' }, {}, '203.0.113.40');
    expect(res.status).toBe(503);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('[client-errors]'), expect.stringContaining('does not exist'), 'SQLSTATE=42P01');
  });
});

describe('дверь', () => {
  it('Edge пускает анонима на POST и не пускает на GET', () => {
    expect(isPublicApiPath('/api/client-errors', 'POST')).toBe(true);
    expect(isPublicApiPath('/api/client-errors', 'GET')).toBe(false);
  });
});
