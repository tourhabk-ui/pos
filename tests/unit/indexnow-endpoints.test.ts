/**
 * IndexNow: оба приёмника, файл /<ключ>.txt, пачки по 10 000,
 * robots.txt открывает названных краулеров и называет sitemap.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('@/lib/database', () => ({ query: vi.fn(async () => ({ rows: [] })) }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/analytics/agent-entry-hits', () => ({ recordAgentEntryHit: vi.fn() }));

import { INDEXNOW_KEY, indexNowBatches, indexNowKeyLocation, pingIndexNow } from '@/lib/seo/indexnow';
import robots from '@/app/robots';
import { aiCrawlerUaFamily } from '@/lib/analytics/ai-crawler-ua';

const SITE = (process.env.NEXT_PUBLIC_SITE_URL || 'https://vedarai.ru').replace(/\/$/, '');

describe('файл ключа и оба приёмника', () => {
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      const status = url.includes('yandex.com') ? 202 : 200;
      return new Response('', { status });
    });
  });
  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('ключ лежит по адресу /<ключ>.txt и в теле файла', () => {
    expect(indexNowKeyLocation(SITE)).toBe(`${SITE}/${INDEXNOW_KEY}.txt`);
    const route = readFileSync(`app/${INDEXNOW_KEY}.txt/route.ts`, 'utf8');
    expect(route).toContain('INDEXNOW_KEY');
    expect(route).toContain('text/plain');
  });

  it('один адрес уходит в IndexNow и в Яндекс с host, key и keyLocation', async () => {
    const r = await pingIndexNow(['/catalog'], { source: 'test' });
    expect(r.ok).toBe(true);
    expect(r.submitted).toBe(1);
    expect(r.endpoints).toEqual([
      { name: 'indexnow', ok: true, status: 200 },
      { name: 'yandex', ok: true, status: 202 },
    ]);
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://api.indexnow.org/indexnow',
      'https://yandex.com/indexnow',
    ]);
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as {
      host: string; key: string; keyLocation: string; urlList: string[];
    };
    expect(body.host).toBe(new URL(SITE).host);
    expect(body.key).toBe(INDEXNOW_KEY);
    expect(body.keyLocation).toBe(`${SITE}/${INDEXNOW_KEY}.txt`);
    expect(body.urlList).toEqual([`${SITE}/catalog`]);
  });

  it('10001 адрес — две пачки, ни один не выброшен', async () => {
    const urls = Array.from({ length: 10001 }, (_, i) => `/p/${i}`);
    expect(indexNowBatches(urls).map((b) => b.length)).toEqual([10000, 1]);
    const r = await pingIndexNow(urls);
    expect(r.submitted).toBe(10001);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('отказ одного приёмника не прячет статус второго', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('yandex.com')) return new Response('bad key', { status: 422 });
      return new Response('', { status: 200 });
    });
    const r = await pingIndexNow(['/catalog']);
    expect(r.ok).toBe(false);
    expect(r.endpoints?.find((e) => e.name === 'indexnow')?.status).toBe(200);
    expect(r.endpoints?.find((e) => e.name === 'yandex')?.status).toBe(422);
    expect(r.error).toMatch(/422/);
  });
});

describe('robots.txt', () => {
  it('называет sitemap и пускает названных краулеров', async () => {
    const body = await robots();
    expect(body.sitemap).toBe(`${SITE}/sitemap.xml`);
    const wanted = ['GPTBot', 'OAI-SearchBot', 'ClaudeBot', 'PerplexityBot', 'YandexBot', 'Bingbot'];
    for (const name of wanted) {
      const rule = body.rules.find((r) => !Array.isArray(r.userAgent) && r.userAgent === name);
      expect(rule, name).toBeTruthy();
      const allow = rule?.allow;
      const allowsRoot = Array.isArray(allow) ? allow.includes('/') : allow === '/';
      expect(allowsRoot, name).toBe(true);
    }
  });
});

describe('сырой User-Agent краулера', () => {
  it('ИИ-краулер, YandexBot и Bingbot записываются, человек — нет', () => {
    expect(aiCrawlerUaFamily('Mozilla/5.0 (compatible; GPTBot/1.2)')).toBe('openai');
    expect(aiCrawlerUaFamily('OAI-SearchBot/1.0')).toBe('openai');
    expect(aiCrawlerUaFamily('ClaudeBot/1.0')).toBe('anthropic');
    expect(aiCrawlerUaFamily('PerplexityBot/1.0')).toBe('perplexity');
    expect(aiCrawlerUaFamily('Mozilla/5.0 (compatible; YandexBot/3.0)')).toBe('yandex');
    expect(aiCrawlerUaFamily('Mozilla/5.0 (compatible; bingbot/2.0)')).toBe('bing');
    expect(aiCrawlerUaFamily('Mozilla/5.0 Chrome/120.0.0.0')).toBeNull();
    expect(aiCrawlerUaFamily('')).toBeNull();
  });
});

describe('полная подача после выкладки', () => {
  it('workflow ждёт прод и зовёт крон, маркер — один прогон', () => {
    const yml = readFileSync('.github/workflows/indexnow-full.yml', 'utf8');
    const wait = yml.indexOf('scripts/wait-for-deploy.sh');
    const call = yml.indexOf('https://vedarai.ru/api/cron/indexnow-full');
    expect(wait).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(wait);
    expect(yml).toMatch(/timeout-minutes:\s*80/);
    expect(yml).toContain('.github/triggers/indexnow-full.json');
    const marker = JSON.parse(readFileSync('.github/triggers/indexnow-full.json', 'utf8')) as { run: number };
    expect(marker.run).toBe(1);
  });
});
