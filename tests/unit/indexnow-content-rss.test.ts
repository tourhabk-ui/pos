/**
 * Сыщик 21.11 (разрыв цитирования в ответах ИИ): хук IndexNow на тексты
 * выката и RSS-лента статей и посадочных.
 *
 * Держится: в подачу идут только тексты (посадочные, статьи, места,
 * маршруты, рыбы, парки, планы) с lastmod не раньше since; роут под секретом
 * и шлёт и в Яндекс, и в Bing; лента — валидный RSS 2.0 без полей, где могли
 * бы оказаться персональные данные.
 */
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

const sitemap = vi.hoisted(() => ({
  entries: [] as Array<{ url: string; lastModified?: Date }>,
}));
vi.mock('@/lib/seo/sitemap-entries', () => ({
  collectSitemapEntriesWithStatus: vi.fn(async () => ({ entries: sitemap.entries, degraded: [] })),
}));
const pings = vi.hoisted(() => [] as Array<{ urls: string[]; endpoint?: string }>);
vi.mock('@/lib/database', () => ({ query: vi.fn(async () => ({ rows: [] })), pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { contentUrlsChangedSince, parseSince, INDEXNOW_BING_ENDPOINT, INDEXNOW_KEY } from '@/lib/seo/indexnow';
import { buildRss, landingFeedItems, sortFeedItems } from '@/lib/seo/rss';

describe('адреса для подачи', () => {
  const entries = [
    { url: 'https://vedarai.ru/splav-na-kamchatke', lastModified: new Date('2026-11-21T00:00:00Z') },
    { url: 'https://vedarai.ru/places/ajnelkan', lastModified: new Date('2026-11-20T22:37:00Z') },
    { url: 'https://vedarai.ru/routes/old', lastModified: new Date('2026-10-01T00:00:00Z') },
    { url: 'https://vedarai.ru/catalog/tours/x', lastModified: new Date('2026-11-21T00:00:00Z') },
    { url: 'https://vedarai.ru/fish/kizuch', lastModified: new Date('2026-11-21T00:00:00Z') },
  ];
  it('только тексты и только свежие', () => {
    const urls = contentUrlsChangedSince(entries, new Date('2026-11-20T00:00:00Z'), ['/splav-na-kamchatke']);
    expect(urls).toEqual([
      'https://vedarai.ru/splav-na-kamchatke', 'https://vedarai.ru/places/ajnelkan', 'https://vedarai.ru/fish/kizuch',
    ]);
  });
  it('since: дата из запроса, иначе двое суток назад', () => {
    expect(parseSince('2026-11-20').toISOString()).toBe('2026-11-20T00:00:00.000Z');
    const now = new Date('2026-11-21T12:00:00Z');
    expect(parseSince(null, now).toISOString()).toBe('2026-11-19T12:00:00.000Z');
    expect(parseSince('мусор', now).toISOString()).toBe('2026-11-19T12:00:00.000Z');
  });
  it('Bing — официальный вход протокола, ключ — тот же публичный', () => {
    expect(INDEXNOW_BING_ENDPOINT).toBe('https://www.bing.com/indexnow');
    expect(INDEXNOW_KEY).toMatch(/^[a-f0-9]{32}$/);
  });
});

describe('роут /api/cron/indexnow-content', () => {
  it('без секрета — 401; с секретом — подача в Яндекс и Bing', async () => {
    const fetchMock = vi.fn(async (url: string, init: { body: string }) => {
      pings.push({ urls: JSON.parse(init.body).urlList, endpoint: url });
      return new Response('', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    process.env.CRON_SECRET = 'test-secret';
    const { GET } = await import('@/app/api/cron/indexnow-content/route');
    const denied = await GET(new NextRequest('http://localhost/api/cron/indexnow-content'));
    expect(denied.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();

    sitemap.entries = [{ url: 'https://vedarai.ru/articles/zima', lastModified: new Date('2026-11-21T00:00:00Z') }];
    const res = await GET(new NextRequest('http://localhost/api/cron/indexnow-content?since=2026-11-20', {
      headers: { authorization: 'Bearer test-secret' },
    }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.submitted).toBe(1);
    expect(pings.map((p) => p.endpoint).sort()).toEqual(['https://www.bing.com/indexnow', 'https://yandex.com/indexnow']);
    expect(pings.every((p) => p.urls[0] === 'https://vedarai.ru/articles/zima')).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe('RSS', () => {
  const items = [
    { title: 'Старое', link: 'https://vedarai.ru/articles/a', description: 'a & b', updated: '2026-10-01T00:00:00.000Z' },
    { title: 'Новое <b>', link: 'https://vedarai.ru/articles/b', description: '', updated: '2026-11-21T00:00:00.000Z' },
    { title: 'Дубль', link: 'https://vedarai.ru/articles/b', description: '', updated: '2026-11-01T00:00:00.000Z' },
  ];
  it('RSS 2.0 со ссылкой на себя, свежие сверху, без дублей, текст экранирован', () => {
    const x = buildRss('https://vedarai.ru/', items);
    expect(x).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<rss version="2.0"/);
    expect(x).toContain('<atom:link href="https://vedarai.ru/rss.xml" rel="self" type="application/rss+xml"/>');
    expect(x.indexOf('Новое')).toBeLessThan(x.indexOf('Старое'));
    expect(x).toContain('Новое &lt;b&gt;');
    expect(x).toContain('a &amp; b');
    expect(x.match(/<item>/g)).toHaveLength(2);
    expect(sortFeedItems(items)).toHaveLength(2);
  });
  it('без полей, где живут персональные данные', () => {
    const x = buildRss('https://vedarai.ru', [...landingFeedItems('https://vedarai.ru'), ...items]);
    expect(x).not.toMatch(/<(author|dc:creator|managingEditor|webMaster)>/);
    expect(x).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
    expect(x).not.toMatch(/\+7[\s(]*9\d{2}/);
  });
  it('посадочные — в ленте со своей датой ревизии', () => {
    const l = landingFeedItems('https://vedarai.ru');
    expect(l.find((i) => i.link === 'https://vedarai.ru/splav-na-kamchatke')?.updated).toBe('2026-11-21T00:00:00.000Z');
  });
});
