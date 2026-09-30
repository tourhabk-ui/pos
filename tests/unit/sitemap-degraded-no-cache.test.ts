/**
 * Урезанный sitemap и llms.txt не кэшируются (сверка SEO 29.09, вечер).
 *
 * С этого дня оба файла отдаются со своим Cache-Control, а не с общим
 * no-store из next.config.js. Но секции читаются из базы, и при отказе
 * выпадают, а ответ остаётся 200: без этой проверки неполный sitemap
 * (без мест, без туров) обходчик держал бы час, а неполный llms.txt —
 * сутки, как настоящие. Поведение проверяется вызовом роута с моком
 * базы, а не видом строки.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

import { GET as sitemapGET } from '@/app/sitemap.xml/route';
import { GET as llmsGET } from '@/app/llms.txt/route';
import { collectSitemapEntriesWithStatus } from '@/lib/seo/sitemap-entries';

beforeEach(() => {
  query.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

/** База отвечает пусто, кроме запросов, текст которых содержит `failOn`. */
function dbFailingOn(failOn: string | null) {
  query.mockImplementation((sql: string) => {
    if (failOn && String(sql).includes(failOn)) return Promise.reject(Object.assign(new Error('boom'), { code: '57P01' }));
    return Promise.resolve({ rows: [] });
  });
}

describe('sitemap.xml', () => {
  it('всё прочиталось — кэш как объявлен', async () => {
    dbFailingOn(null);
    const res = await sitemapGET();
    expect(res.headers.get('Cache-Control')).toMatch(/^public, max-age=0, s-maxage=3600/);
  });

  it('секция мест упала — no-store, а имя секции в логе', async () => {
    dbFailingOn('FROM places');
    const res = await sitemapGET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1]).toBe('места');
  });

  it('упала секция туров — тоже no-store', async () => {
    dbFailingOn('FROM operator_tours');
    const res = await sitemapGET();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('сборщик называет упавшие секции', async () => {
    dbFailingOn('FROM kamchatka_routes kr');
    const { degraded } = await collectSitemapEntriesWithStatus();
    expect(degraded).toContain('маршруты');
  });
});

describe('llms.txt', () => {
  it('всё прочиталось — сутки кэша', async () => {
    dbFailingOn(null);
    const res = await llmsGET();
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400, s-maxage=86400');
  });

  it('туры не прочитались — no-store', async () => {
    dbFailingOn('FROM operator_tours');
    const res = await llmsGET();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('места не прочитались — no-store', async () => {
    dbFailingOn('FROM places');
    const res = await llmsGET();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
