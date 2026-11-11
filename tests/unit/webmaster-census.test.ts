/**
 * Перепись Яндекс Вебмастера (08.11): токен по имени переменной, значение не
 * выходит наружу; данные — по разделам, отказ раздела назван словами.
 *
 * Судится вызовом с подставленной сетью: какие адреса API зовутся, что
 * попадает в ответ и чего в нём нет.
 */
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { tokenCandidates, webmasterCensus, excludedByReason, pickOurHost, type Fetcher } from '@/lib/seo/webmaster-census';

const GOOD = 'y0_test_good_token_value_000';
const BAD = 'y0_test_bad_token_value_111';
const HOST_ID = 'https:vedarai.ru:443';

/** Подставная сеть: отвечает по пути и записывает, что звали и с каким токеном. */
function fakeApi(opts: { summaryFails?: boolean; httpFirst?: boolean } = {}) {
  const calls: Array<{ path: string; auth: string }> = [];
  const fetcher: Fetcher = async (url, init) => {
    const path = url.replace('https://api.webmaster.yandex.net/v4', '');
    calls.push({ path, auth: init.headers.Authorization });
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (init.headers.Authorization !== `OAuth ${GOOD}`) return json(401, { error_code: 'INVALID_OAUTH_TOKEN' });
    if (path === '/user') return json(200, { user_id: 42 });
    if (path === '/user/42/hosts') {
      return json(200, { hosts: [
        { host_id: 'https:other.ru:443', ascii_host_url: 'https://other.ru/', verified: true },
        // Прогон 2 (11.11): в аккаунте был только http://vedarai.ru/ — с нулями.
        ...(opts.httpFirst ? [{ host_id: 'http:vedarai.ru:80', ascii_host_url: 'http://vedarai.ru/', verified: true }] : []),
        { host_id: HOST_ID, ascii_host_url: 'https://vedarai.ru/', verified: true },
      ] });
    }
    const h = `/user/42/hosts/${encodeURIComponent(HOST_ID)}`;
    if (path === `${h}/summary`) {
      return opts.summaryFails ? json(404, { error_code: 'HOST_NOT_LOADED' })
        : json(200, { sqi: 10, searchable_pages_count: 120, excluded_pages_count: 300, site_problems: {} });
    }
    if (path.startsWith(`${h}/search-queries/popular?`)) {
      return json(200, { count: 3, date_from: '2026-08-10', date_to: '2026-11-08', queries: [
        { query_text: 'туры на камчатку', indicators: { TOTAL_SHOWS: 40, TOTAL_CLICKS: 2, AVG_SHOW_POSITION: 31.5 } },
        { query_text: 'ведар', indicators: { TOTAL_SHOWS: 90, TOTAL_CLICKS: 30 } },
        { query_text: 'курильское озеро медведи', indicators: { TOTAL_SHOWS: 5 } },
      ] });
    }
    if (path.startsWith(`${h}/search-urls/in-search/samples?`)) {
      return json(200, { count: 120, samples: [{ url: 'https://vedarai.ru/catalog' }] });
    }
    if (path.startsWith(`${h}/search-urls/events/samples?`)) {
      return json(200, { count: 7, samples: [
        { url: 'https://vedarai.ru/a', event: 'REMOVED_FROM_SEARCH', excluded_url_status: 'DUPLICATE' },
        { url: 'https://vedarai.ru/b', event: 'REMOVED_FROM_SEARCH', excluded_url_status: 'DUPLICATE' },
        { url: 'https://vedarai.ru/c', event: 'REMOVED_FROM_SEARCH', excluded_url_status: 'HTTP_ERROR', bad_http_status: 404 },
        { url: 'https://vedarai.ru/d', event: 'APPEARED_IN_SEARCH' },
      ] });
    }
    return json(404, { error_code: 'NOT_FOUND' });
  };
  return { fetcher, calls };
}

const ENV = {
  CRON_SECRET: 'x',
  YANDEX_GPT_API_KEY: 'gpt-key',
  YANDEX_OAUTH_TOKEN: BAD,
  YANDEX_WEBMASTER_TOKEN: GOOD,
  WEBMASTER_EMPTY: '   ',
  DATABASE_URL: 'postgres://secret',
};

describe('tokenCandidates: по именам, без значений', () => {
  it('берёт непустые имена про Вебмастер первыми, затем токены Яндекса; ключ модели и секреты — нет', () => {
    const { candidates, yandex_names } = tokenCandidates(ENV);
    expect(candidates).toEqual(['YANDEX_WEBMASTER_TOKEN', 'YANDEX_OAUTH_TOKEN']);
    expect(tokenCandidates({ YANDEX_OAUTH_CLIENT_SECRET: 's', YANDEX_TOKEN_PASSWORD: 'p', YANDEX_METRIKA_TOKEN: 't' }).candidates)
      .toEqual(['YANDEX_METRIKA_TOKEN']);
    // Ключ с именем Вебмастера пробуется, ключ Облака (YandexGPT) — нет; секрет приложения — никогда.
    expect(tokenCandidates({ YANDEX_WEBMASTER_API_KEY: 'k', YANDEX_API_KEY: 'gpt', WEBMASTER_CLIENT_SECRET: 's' }).candidates)
      .toEqual(['YANDEX_WEBMASTER_API_KEY']);
    expect(yandex_names).toEqual(['WEBMASTER_EMPTY', 'YANDEX_GPT_API_KEY', 'YANDEX_OAUTH_TOKEN', 'YANDEX_WEBMASTER_TOKEN']);
  });
});

describe('webmasterCensus: перепись целиком', () => {
  it('неподходящий токен пропускается, подходящий назван именем; значений в ответе нет', async () => {
    const { fetcher } = fakeApi();
    const env = { ...ENV, YANDEX_WEBMASTER_TOKEN: BAD, YANDEX_OAUTH_TOKEN: GOOD };
    const r = await webmasterCensus({ env, fetcher, today: '2026-11-08', days: 90, topQueries: 200 });
    expect(r.token.found_as).toBe('YANDEX_OAUTH_TOKEN');
    expect(r.token.tried[0]).toEqual({ name: 'YANDEX_WEBMASTER_TOKEN', result: 'HTTP 401 (INVALID_OAUTH_TOKEN) на /user' });
    const text = JSON.stringify(r);
    for (const secret of [GOOD, BAD, 'gpt-key', 'postgres://secret']) expect(text).not.toContain(secret);
  });

  it('хост vedarai.ru найден, разделы прочитаны по его id', async () => {
    const { fetcher, calls } = fakeApi();
    const r = await webmasterCensus({ env: ENV, fetcher, today: '2026-11-08', days: 90, topQueries: 200 });
    expect(r.host_id).toBe(HOST_ID);
    // Чужой сайт аккаунта не назван — только сколько их и наш.
    expect(r.hosts).toEqual({ ok: true, data: { total: 2, site: { url: 'https://vedarai.ru/', verified: true } } });
    expect(JSON.stringify(r)).not.toContain('other.ru');
    expect(r.summary).toEqual({ ok: true, data: { sqi: 10, searchable_pages_count: 120, excluded_pages_count: 300, site_problems: {} } });
    expect(r.in_search).toEqual({ ok: true, data: { total: 120, urls: ['https://vedarai.ru/catalog'] } });
    const q = r.queries!;
    expect(q.ok && q.data.top.map((x) => x.query)).toEqual(['ведар', 'туры на камчатку', 'курильское озеро медведи']);
    const popular = calls.find((c) => c.path.includes('/search-queries/popular'))!.path;
    expect(popular).toContain('order_by=TOTAL_SHOWS');
    expect(popular).toContain('date_from=2026-08-10');
    expect(popular).toContain('query_indicator=AVG_CLICK_POSITION');
  });

  it('исключённые — по причинам, с кодом ответа у HTTP_ERROR', async () => {
    const { fetcher } = fakeApi();
    const r = await webmasterCensus({ env: ENV, fetcher, today: '2026-11-08', days: 90, topQueries: 200 });
    expect(r.excluded).toEqual({ ok: true, data: {
      events_total: 7, removed_in_sample: 3,
      by_reason: [
        { reason: 'DUPLICATE', count: 2, examples: ['https://vedarai.ru/a', 'https://vedarai.ru/b'] },
        { reason: 'HTTP_ERROR 404', count: 1, examples: ['https://vedarai.ru/c'] },
      ],
    } });
  });

  it('отказ раздела назван словами, остальные разделы читаются', async () => {
    const { fetcher } = fakeApi({ summaryFails: true });
    const r = await webmasterCensus({ env: ENV, fetcher, today: '2026-11-08', days: 90, topQueries: 200 });
    expect(r.summary).toEqual({ ok: false, error: `HTTP 404 (HOST_NOT_LOADED) на /user/{u}/hosts/${encodeURIComponent(HOST_ID)}/summary` });
    expect(r.queries?.ok).toBe(true);
  });

  it('токена нет — только раздел токена с именами про Яндекс, к API ни одного вызова с чужим ключом', async () => {
    const { fetcher, calls } = fakeApi();
    const r = await webmasterCensus({ env: { YANDEX_GPT_API_KEY: 'gpt-key' }, fetcher, today: '2026-11-08', days: 90, topQueries: 200 });
    expect(r).toEqual({ token: { found_as: null, tried: [], yandex_names: ['YANDEX_GPT_API_KEY'] } });
    expect(calls).toEqual([]);
  });

  it('excludedByReason: появившиеся в поиске не считаются исключёнными', () => {
    expect(excludedByReason([{ url: 'u', event: 'APPEARED_IN_SEARCH' }])).toEqual([]);
  });
});

describe('роут /api/cron/webmaster-census', () => {
  it('без CRON_SECRET в заголовке — 401, к API не ходит', async () => {
    vi.stubEnv('CRON_SECRET', 'secret-for-test');
    const spy = vi.spyOn(globalThis, 'fetch');
    const { GET } = await import('@/app/api/cron/webmaster-census/route');
    const res = await GET(new NextRequest('https://vedarai.ru/api/cron/webmaster-census'));
    expect(res.status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    vi.unstubAllEnvs();
  });
});

describe('какой из наших хостов читать (прогон 2, 11.11)', () => {
  it('http и https в аккаунте — читается https, даже если http стоит первым', async () => {
    const { fetcher, calls } = fakeApi({ httpFirst: true });
    const r = await webmasterCensus({ env: ENV, fetcher, today: '2026-11-11', days: 90, topQueries: 10 });
    expect(r.host_id).toBe(HOST_ID);
    expect(calls.some((c) => c.path.includes(encodeURIComponent('http:vedarai.ru:80')))).toBe(false);
  });

  it('порядок: https с правами, https, http с правами, http', () => {
    const h = (url: string, verified: boolean) => ({ host_id: url, ascii_host_url: url, verified });
    expect(pickOurHost([h('http://vedarai.ru/', true), h('https://vedarai.ru/', false)])?.ascii_host_url).toBe('https://vedarai.ru/');
    expect(pickOurHost([h('https://vedarai.ru/', false), h('https://www.vedarai.ru/', true)])?.ascii_host_url).toBe('https://www.vedarai.ru/');
    expect(pickOurHost([h('http://vedarai.ru/', false), h('http://www.vedarai.ru/', true)])?.ascii_host_url).toBe('http://www.vedarai.ru/');
    expect(pickOurHost([])).toBeUndefined();
  });
});
