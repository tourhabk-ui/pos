/**
 * Внешний аудит 16.11 (#3463): Permissions-Policy, кэш списка туров и lastmod.
 *
 * Заголовки — сопоставлением путей тем же матчером, что у Next для headers()
 * (как в china-quick.test.ts). Кэш — вызовом роута. lastmod — по SQL запросов
 * sitemap, по смыслу (дата создания там, где обновления нет).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';
import { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => queryMock(...a) }));

import { GET as toursList } from '@/app/api/tours/route';
import { PARTNER_PAGES_SQL } from '@/lib/seo/partner-sitemap';

const ROOT = join(__dirname, '..', '..');

const { getPathMatch } = require('next/dist/shared/lib/router/utils/path-match') as {
  getPathMatch: (source: string, opts: Record<string, unknown>) => (path: string) => false | object;
};
const config = require(join(ROOT, 'next.config.js')) as {
  headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>>;
};

async function headerFor(path: string, key: string): Promise<string[]> {
  const rules = await config.headers();
  return rules
    .filter((r) => getPathMatch(r.source, { strict: true, removeUnnamedParams: true })(path) !== false)
    .flatMap((r) => r.headers.filter((h) => h.key.toLowerCase() === key.toLowerCase()).map((h) => h.value));
}

function parsePolicy(v: string): Map<string, string> {
  return new Map(v.split(',').map((d) => d.trim()).map((d) => {
    const i = d.indexOf('=');
    return [d.slice(0, i), d.slice(i + 1)] as [string, string];
  }));
}

describe('Permissions-Policy', () => {
  it('ровно один заголовок на странице, виджете и API', async () => {
    for (const p of ['/', '/planning', '/ai-assistant', '/widget/abc', '/api/tours', '/hub/operator']) {
      expect(await headerFor(p, 'Permissions-Policy'), p).toHaveLength(1);
    }
  });

  it('датчики и устройства, нужные платформе, — своему сайту, не запрещены', async () => {
    const [v] = await headerFor('/planning', 'Permissions-Policy');
    const pol = parsePolicy(v);
    // камера — сканер QR на SOS, микрофон — голосовой ввод, геолокация — SOS,
    // датчики ориентации — компас /planning. Пустой список сломал бы их.
    for (const f of ['camera', 'microphone', 'geolocation', 'accelerometer', 'gyroscope', 'magnetometer']) {
      expect(pol.get(f), f).toBe('(self)');
    }
  });

  it('USB, serial, Bluetooth, HID, MIDI — запрещены всем', async () => {
    const [v] = await headerFor('/', 'Permissions-Policy');
    const pol = parsePolicy(v);
    for (const f of ['usb', 'serial', 'bluetooth', 'hid', 'midi']) expect(pol.get(f), f).toBe('()');
  });
});

describe('/api/tours — минута кэша, отказ не кэшируется', () => {
  beforeEach(() => queryMock.mockReset());

  it('успешный ответ — public, max-age=60', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const res = await toursList(new NextRequest('https://vedarai.ru/api/tours'));
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
  });

  it('деградация — no-store: пустой список не застревает в кэше', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ rows: [] });
    const res = await toursList(new NextRequest('https://vedarai.ru/api/tours'));
    const body = (await res.json()) as { degraded?: boolean };
    expect(body.degraded).toBe(true);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('sitemap lastmod — дата создания там, где updated_at пуст', () => {
  it('страницы партнёров', () => {
    expect(PARTNER_PAGES_SQL).toMatch(/COALESCE\(p\.updated_at,\s*p\.created_at\)\s+AS updated_at/);
  });
  it('туры', () => {
    const src = require('fs').readFileSync(join(ROOT, 'lib/seo/sitemap-entries.ts'), 'utf8') as string;
    expect(src).toMatch(/COALESCE\(ot\.updated_at,\s*ot\.created_at\)\s+AS updated_at/);
  });
});
