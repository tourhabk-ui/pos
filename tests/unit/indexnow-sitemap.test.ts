/**
 * Сторож: вся карта сайта уходит в IndexNow роутом под CRON_SECRET, из того
 * же источника, что /sitemap.xml, и только после своей сборки.
 *
 * ── Откуда ────────────────────────────────────────────────────────────────
 *
 * 19.11, задача «Завести страницы Ведара в индекс»: https-хост в Вебмастере
 * Яндекса не загружен, в выдаче четыре адреса. Подать всю карту в IndexNow
 * можно было только под admin-JWT (/api/admin/indexnow/bulk) — раннеру
 * недоступно.
 *
 * ── Что держится ──────────────────────────────────────────────────────────
 *
 * Адреса — из collectSitemapEntriesWithStatus, не второй список; чужой хост в
 * пинг не идёт (IndexNow отвергает всю пачку); неполная карта — 502 с именем
 * секции, но прочитанное уходит; пустая — 502 без пинга (§4.0: ноль на
 * входе — отказ). Workflow ждёт свою сборку, идёт только из main.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

vi.mock('@/lib/seo/indexnow', () => ({
  pingIndexNow: vi.fn(async (urls: string[]) => ({ ok: true, submitted: urls.length, status: 200 })),
}));
const map = vi.hoisted(() => ({
  entries: [] as Array<{ url: string }>,
  degraded: [] as string[],
}));
vi.mock('@/lib/seo/sitemap-entries', () => ({
  collectSitemapEntriesWithStatus: vi.fn(async () => ({ entries: map.entries, degraded: map.degraded })),
}));
vi.mock('@/lib/config', () => ({ getPublicBaseUrl: () => 'https://vedarai.ru' }));

import { GET, sitemapPingUrls, SITEMAP_PING_MAX } from '@/app/api/cron/indexnow-sitemap/route';
import { pingIndexNow } from '@/lib/seo/indexnow';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const CODE = read('.github/workflows/indexnow-sitemap.yml').replace(/^[ \t]*#.*$/gm, '');
const req = (auth?: string) => new NextRequest('http://localhost/api/cron/indexnow-sitemap', {
  headers: auth ? { authorization: auth } : {},
});

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret';
  map.entries = [];
  map.degraded = [];
  vi.mocked(pingIndexNow).mockClear();
});

describe('адреса карты для пинга', () => {
  it('только свой хост, без повторов, в порядке карты; чужие и битые считаются', () => {
    const r = sitemapPingUrls([
      { url: 'https://vedarai.ru/' },
      { url: 'https://vedarai.ru/places/avachinskij' },
      { url: 'https://vedarai.ru/places/avachinskij' },
      { url: 'https://tourhab.ru/catalog' },
      { url: 'не адрес' },
    ], 'https://vedarai.ru');
    expect(r.urls).toEqual(['https://vedarai.ru/', 'https://vedarai.ru/places/avachinskij']);
    expect(r.foreign).toBe(2);
    expect(r.truncated).toBe(0);
  });

  it('сверх предела — режется и называется числом', () => {
    const many = Array.from({ length: SITEMAP_PING_MAX + 3 }, (_, i) => ({ url: `https://vedarai.ru/p/${i}` }));
    const r = sitemapPingUrls(many, 'https://vedarai.ru');
    expect(r.urls.length).toBe(SITEMAP_PING_MAX);
    expect(r.truncated).toBe(3);
  });
});

describe('роут', () => {
  it('без секрета — 401, пинга нет', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(pingIndexNow).not.toHaveBeenCalled();
  });

  it('полная карта — 200, в пинге ровно адреса карты своего хоста', async () => {
    map.entries = [{ url: 'https://vedarai.ru/' }, { url: 'https://vedarai.ru/catalog' }, { url: 'https://www.vedarai.ru/x' }];
    const res = await GET(req('Bearer test-secret'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.submitted).toBe(2);
    expect(body.foreign_host_dropped).toBe(1);
    expect(vi.mocked(pingIndexNow).mock.calls[0][0]).toEqual(['https://vedarai.ru/', 'https://vedarai.ru/catalog']);
    expect(vi.mocked(pingIndexNow).mock.calls[0][1]).toEqual({ source: 'indexnow-sitemap' });
  });

  it('карта неполна — прочитанное уходит, ответ 502 называет секцию', async () => {
    map.entries = [{ url: 'https://vedarai.ru/' }];
    map.degraded = ['маршруты'];
    const res = await GET(req('Bearer test-secret'));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.degraded_sections).toEqual(['маршруты']);
    expect(body.error).toMatch(/маршруты/);
    expect(pingIndexNow).toHaveBeenCalledTimes(1);
  });

  it('пустая карта — 502 без пинга', async () => {
    const res = await GET(req('Bearer test-secret'));
    expect(res.status).toBe(502);
    expect((await res.json()).submitted).toBe(0);
    expect(pingIndexNow).not.toHaveBeenCalled();
  });

  it('IndexNow отверг — 502 со словами протокола', async () => {
    map.entries = [{ url: 'https://vedarai.ru/' }];
    vi.mocked(pingIndexNow).mockResolvedValueOnce({ ok: false, submitted: 1, status: 422, error: 'HTTP 422: host mismatch' });
    const res = await GET(req('Bearer test-secret'));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.status).toBe(422);
    expect(body.error).toMatch(/422/);
  });
});

describe('workflow', () => {
  it('маркер, только main, ждёт свою сборку, секрет проверяется до запроса, красный на не-200', () => {
    expect(CODE).toMatch(/\.github\/triggers\/indexnow-sitemap\.json/);
    expect(CODE).toMatch(/branches: \[main\]/);
    expect(CODE).toMatch(/run: bash scripts\/wait-for-deploy\.sh/);
    const secretCheck = CODE.indexOf('secrets.CRON_SECRET }}" ]; then');
    const ping = CODE.indexOf('api/cron/indexnow-sitemap');
    expect(secretCheck).toBeGreaterThan(0);
    expect(ping).toBeGreaterThan(secretCheck);
    expect(CODE).toMatch(/if \[ "\$HTTP" != "200" \]; then[\s\S]*?exit 1/);
    expect(JSON.parse(read('.github/triggers/indexnow-sitemap.json'))).toHaveProperty('run');
  });
});
