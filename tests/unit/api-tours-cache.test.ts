/**
 * Кэш публичного списка туров (аудит 16.11, #3463 п. 3): вызовом роута и
 * действующим заголовком из next.config.js.
 *
 *   - успех — `public, max-age=60`, и общий no-store его не перебивает;
 *   - отказ базы (`degraded`) — `no-store`: пустой список не застревает в кэше;
 *   - обстановка и вулканы под общим no-store остаются: устаревшая тревога
 *     хуже лишнего запроса.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/database', () => ({ query: (sql: string, p?: unknown[]) => h.query(sql, p ?? []) }));

import { GET } from '@/app/api/tours/route';

const req = createRequire(import.meta.url);
type HeaderRule = { source: string; headers: { key: string; value: string }[] };
type Matcher = (path: string) => false | Record<string, unknown>;
const { getPathMatch } = req('next/dist/shared/lib/router/utils/path-match') as {
  getPathMatch: (source: string, opts: Record<string, unknown>) => Matcher;
};
const { modifyRouteRegex } = req('next/dist/lib/redirect-status') as { modifyRouteRegex: (regex: string) => string };

/** Действующее значение заголовка из next.config.js: побеждает последняя совпавшая запись. */
async function effective(path: string, key: string): Promise<string | null> {
  const cfg = req(join(process.cwd(), 'next.config.js')) as { headers: () => Promise<HeaderRule[]> };
  let value: string | null = null;
  for (const rule of await cfg.headers()) {
    const match = getPathMatch(rule.source, { strict: true, removeUnnamedParams: true, regexModifier: (r: string) => modifyRouteRegex(r) });
    if (match(path) === false) continue;
    for (const hd of rule.headers) if (hd.key.toLowerCase() === key.toLowerCase()) value = hd.value;
  }
  return value;
}

const call = () => GET(new NextRequest('http://localhost/api/tours?limit=5'));

beforeEach(() => {
  h.query.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('/api/tours: кэш на минуту, отказ не кэшируется', () => {
  it('успех — public, max-age=60', async () => {
    h.query.mockImplementation(async (sql: string) => (/COUNT\(\*\)/i.test(sql) ? { rows: [{ total: '0' }] } : { rows: [] }));
    const res = await call();
    const body = await res.json();
    expect(body.degraded).toBeUndefined();
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
  });

  it('отказ базы — degraded и no-store', async () => {
    h.query.mockRejectedValue(Object.assign(new Error('down'), { code: '57P01' }));
    const res = await call();
    expect((await res.json()).degraded).toBe(true);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('общий no-store из next.config не перебивает список; обстановка и вулканы — под ним', async () => {
    expect(await effective('/api/tours', 'Cache-Control')).toBeNull();
    for (const p of ['/api/tours/51', '/api/public/safety-status', '/api/public/danger-summary', '/api/safety/volcanic']) {
      expect(await effective(p, 'Cache-Control'), p).toMatch(/no-store/);
    }
  });
});
