/**
 * robots.txt открывает под `/api/` ровно фото страниц и читающие эндпоинты из
 * openapi.json, а метаданные в <head> получает каждый бот, которого robots.txt
 * приглашает поимённо (аудит 09.11).
 *
 * Было: `Disallow: /api/` у всех 34 групп закрывал og:image 160 страниц и все
 * GET, которые llms.txt предлагает агентам; GPTBot, ClaudeBot и ещё 13 ботов
 * получали title и canonical в <body> (их не было в htmlLimitedBots).
 *
 * Судится вызовом: robots() отдаёт правила, по ним считается, разрешён ли
 * адрес (самое длинное совпадение, при равенстве — Allow, как у Google и
 * Яндекса); список ботов next.config.js проверяется на настоящих строках
 * User-Agent.
 */
import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';

vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'user-agent': 'test' }) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

const { default: robots } = await import('@/app/robots');
const { buildOpenApiDocument } = await import('@/lib/api/openapi');

type Rule = { userAgent?: string | string[]; allow?: string | string[]; disallow?: string | string[] };
const list = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Разрешён ли путь группе: самое длинное совпадение префикса, при равенстве — Allow. */
function allowed(rule: Rule, path: string): boolean {
  let best = { len: -1, allow: true };
  for (const [rules, allow] of [[list(rule.allow), true], [list(rule.disallow), false]] as const) {
    for (const r of rules) {
      if (!path.startsWith(r)) continue;
      if (r.length > best.len || (r.length === best.len && allow)) best = { len: r.length, allow };
    }
  }
  return best.allow;
}

const rules = async () => (await robots()).rules as Rule[];

const IMAGE_URLS = [
  '/api/images/s3/photos/fishingkam/catch-01.jpg',
  '/api/images/route/7412e1c7-7b5c-4ee0-b0e9-4552bb6ff3ff',
  '/api/photos/images/tours/zaporozhets-gorelyy-01.jpg',
];
const PRIVATE = ['/api/hub/bookings/create', '/api/admin/users', '/api/cron/webmaster-census', '/api/auth/login', '/hub/operator', '/auth/login'];

describe('robots.txt: фото и читающие эндпоинты открыты, кабинеты и кроны — нет', () => {
  it('у каждой группы: фото страниц разрешены', async () => {
    for (const r of await rules()) {
      for (const url of IMAGE_URLS) expect(allowed(r, url), `${String(r.userAgent)} ${url}`).toBe(true);
    }
  });

  it('у каждой группы: каждый GET из openapi.json разрешён — ровно то, что llms.txt предлагает агентам', async () => {
    const doc = buildOpenApiDocument('https://vedarai.ru') as { paths: Record<string, Record<string, unknown>> };
    const gets = Object.entries(doc.paths).filter(([, ops]) => 'get' in ops).map(([p]) => p.replace(/\{[^}]+\}/g, '1'));
    expect(gets.filter((p) => p.startsWith('/api/')).length).toBeGreaterThanOrEqual(10);
    for (const r of await rules()) {
      for (const p of gets) expect(allowed(r, p), `${String(r.userAgent)} ${p}`).toBe(true);
    }
  });

  it('у каждой группы: кабинеты, кроны, админка и вход закрыты по-прежнему', async () => {
    for (const r of await rules()) {
      for (const p of PRIVATE) expect(allowed(r, p), `${String(r.userAgent)} ${p}`).toBe(false);
    }
  });
});

describe('метаданные в <head> — каждому боту, которого robots.txt приглашает поимённо', () => {
  it('каждый поимённый бот robots.txt — в htmlLimitedBots next.config.js', async () => {
    const cfg = require(join(process.cwd(), 'next.config.js')) as { htmlLimitedBots: RegExp };
    const named = (await rules()).flatMap((r) => list(r.userAgent)).filter((ua) => ua !== '*');
    expect(named.length).toBeGreaterThan(20);
    for (const ua of named) {
      expect(cfg.htmlLimitedBots.test(`Mozilla/5.0 (compatible; ${ua}/1.0; +https://example.com/bot)`), ua).toBe(true);
    }
    // Браузер человека — не бот: стриминг метаданных у людей сохраняется.
    expect(cfg.htmlLimitedBots.test('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/141 Mobile Safari/537.36')).toBe(false);
  });
});
