// @vitest-environment node
/**
 * Загрузка в Яндекс Вебмастер (11.11, владелец: «поработай с вебмастером,
 * загрузи им наши файлы»): карта сайта и переобход главных страниц.
 *
 * Судится вызовом с подставленной сетью: какие пишущие запросы ушли, что
 * не ушло (чужие адреса, сверх квоты, уже добавленное) и как назван отказ.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { webmasterSubmit, submitDigest, submitOutcome, isOurUrl, type WriteFetcher } from '@/lib/seo/webmaster-submit';

const TOKEN = 'y0_test_token_value_0000';
const HTTPS = 'https:vedarai.ru:443';
const SITEMAP = 'https://vedarai.ru/sitemap.xml';

function fakeApi(opts: { have?: string[]; remainder?: number; postFails?: string; httpFirst?: boolean } = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const fetcher: WriteFetcher = async (url, init) => {
    const path = url.replace('https://api.webmaster.yandex.net/v4', '');
    calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined });
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (init.headers.Authorization !== `OAuth ${TOKEN}`) return json(401, { error_code: 'INVALID_OAUTH_TOKEN' });
    if (path === '/user') return json(200, { user_id: 7 });
    if (path === '/user/7/hosts') {
      return json(200, { hosts: [
        ...(opts.httpFirst ? [{ host_id: 'http:vedarai.ru:80', ascii_host_url: 'http://vedarai.ru/', verified: true }] : []),
        { host_id: HTTPS, ascii_host_url: 'https://vedarai.ru/', verified: true },
      ] });
    }
    const h = `/user/7/hosts/${encodeURIComponent(HTTPS)}`;
    if (init.method === 'POST' && opts.postFails) return json(404, { error_code: opts.postFails });
    if (path === `${h}/user-added-sitemaps` && init.method === 'GET') {
      return json(200, { sitemaps: (opts.have ?? []).map((u) => ({ sitemap_id: 's1', sitemap_url: u })) });
    }
    if (path === `${h}/user-added-sitemaps` && init.method === 'POST') return json(201, { sitemap_id: 's2' });
    if (path === `${h}/recrawl/quota`) return json(200, { daily_quota: 20, quota_remainder: opts.remainder ?? 20 });
    if (path === `${h}/recrawl/queue`) return json(202, { task_id: 't1', quota_remainder: 1 });
    return json(404, { error_code: 'NOT_FOUND' });
  };
  return { fetcher, calls };
}

const posts = (calls: Array<{ method: string; path: string; body?: unknown }>) => calls.filter((c) => c.method === 'POST');

describe('загрузка в Вебмастер', () => {
  it('карта сайта и переобход уходят на https-хост, даже если http в списке первым', async () => {
    const { fetcher, calls } = fakeApi({ httpFirst: true });
    const r = await webmasterSubmit({ token: TOKEN, fetcher, sitemaps: [SITEMAP], recrawl: ['https://vedarai.ru/', 'https://vedarai.ru/catalog'] });
    expect(r.sitemaps).toEqual([{ url: SITEMAP, outcome: 'done' }]);
    expect(r.recrawl.map((i) => i.outcome)).toEqual(['done', 'done']);
    expect(posts(calls).every((c) => c.path.includes(encodeURIComponent(HTTPS)))).toBe(true);
    expect(posts(calls).map((c) => c.body)).toEqual([{ url: SITEMAP }, { url: 'https://vedarai.ru/' }, { url: 'https://vedarai.ru/catalog' }]);
    expect(submitOutcome(r).level).toBe('ok');
  });

  it('уже добавленная карта повторно не шлётся', async () => {
    const { fetcher, calls } = fakeApi({ have: [SITEMAP] });
    const r = await webmasterSubmit({ token: TOKEN, fetcher, sitemaps: [SITEMAP], recrawl: [] });
    expect(r.sitemaps).toEqual([{ url: SITEMAP, outcome: 'already' }]);
    expect(posts(calls)).toHaveLength(0);
  });

  it('сверх остатка квоты переобход не шлётся', async () => {
    const { fetcher, calls } = fakeApi({ remainder: 1 });
    const r = await webmasterSubmit({ token: TOKEN, fetcher, sitemaps: [], recrawl: ['https://vedarai.ru/', 'https://vedarai.ru/zh'] });
    expect(r.recrawl.map((i) => i.outcome)).toEqual(['done', 'no_quota']);
    expect(posts(calls)).toHaveLength(1);
    expect(submitOutcome(r).level).toBe('warning');
  });

  it('чужие адреса не отправляются и названы', async () => {
    const { fetcher, calls } = fakeApi();
    const r = await webmasterSubmit({ token: TOKEN, fetcher, sitemaps: ['https://evil.example/sitemap.xml'], recrawl: ['http://vedarai.ru/', 'https://vedarai.ru.evil.example/'] });
    expect(r.rejected).toHaveLength(3);
    expect(posts(calls)).toHaveLength(0);
    expect(isOurUrl('https://vedarai.ru/places')).toBe(true);
    expect(isOurUrl('https://user@vedarai.ru/')).toBe(false);
    expect(submitOutcome(r).level).toBe('error');
  });

  it('сайт ещё не загружен (HOST_NOT_LOADED) — отказ назван кодом, прогон красный', async () => {
    const { fetcher } = fakeApi({ postFails: 'HOST_NOT_LOADED' });
    const r = await webmasterSubmit({ token: TOKEN, fetcher, sitemaps: [SITEMAP], recrawl: ['https://vedarai.ru/'] });
    expect(r.sitemaps[0]).toMatchObject({ outcome: 'failed' });
    expect((r.sitemaps[0] as { detail: string }).detail).toMatch(/HTTP 404 \(HOST_NOT_LOADED\) на POST \/user\/\{u\}\/hosts/);
    expect(submitOutcome(r).level).toBe('error');
  });

  it('токена нет — в сеть не ходим; не принят — причина названа', async () => {
    const { fetcher, calls } = fakeApi();
    const none = await webmasterSubmit({ token: '  ', fetcher, sitemaps: [SITEMAP], recrawl: [] });
    expect(none.token).toBeNull();
    expect(calls).toHaveLength(0);
    const bad = await webmasterSubmit({ token: 'y0_wrong', fetcher, sitemaps: [SITEMAP], recrawl: [] });
    expect(bad.token).toMatch(/INVALID_OAUTH_TOKEN/);
    expect(submitOutcome(bad).level).toBe('error');
  });

  it('сводка не несёт значения токена', async () => {
    const { fetcher } = fakeApi();
    const r = await webmasterSubmit({ token: TOKEN, fetcher, sitemaps: [SITEMAP], recrawl: ['https://vedarai.ru/'] });
    const text = submitDigest(r).join('\n');
    expect(text).not.toContain(TOKEN);
    expect(text).toContain('https://vedarai.ru/sitemap.xml — отправлено');
  });
});

describe('workflow и маркер', () => {
  const wf = readFileSync(join(process.cwd(), '.github/workflows/webmaster-submit.yml'), 'utf8');
  const marker = JSON.parse(readFileSync(join(process.cwd(), '.github/triggers/webmaster-submit.json'), 'utf8')) as { sitemaps: string[]; recrawl: string[] };

  it('по маркеру, токен — только секрет, переменных репозитория нет', () => {
    expect(wf).toContain("- '.github/triggers/webmaster-submit.json'");
    expect(wf).toContain('YANDEX_WEBMASTER_TOKEN: ${{ secrets.YANDEX_WEBMASTER_TOKEN }}');
    expect(wf).not.toMatch(/\$\{\{\s*vars\./);
    expect(wf).toContain('npx tsx scripts/webmaster-submit.ts .github/triggers/webmaster-submit.json');
  });

  it('в маркере только адреса нашего сайта', () => {
    for (const u of [...marker.sitemaps, ...marker.recrawl]) expect(isOurUrl(u), u).toBe(true);
    expect(marker.sitemaps).toContain(SITEMAP);
  });
});
