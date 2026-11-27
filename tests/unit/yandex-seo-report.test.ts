/**
 * Еженедельный отчёт Вебмастера и Метрики (27.11): токен по имени секрета,
 * значение наружу не уходит; отказ раздела назван словами API.
 *
 * Судится вызовом с подставленной сетью: какие адреса зовутся, что попадает
 * в сводку и чего в ней нет.
 */
import { describe, it, expect } from 'vitest';
import {
  TOKEN_ENV,
  EXPECTED_USER_ID,
  REPORT_HOST_IDS,
  collectYandexSeoReport,
  formatApiError,
  readToken,
  renderReportMarkdown,
  reportOutcome,
  scrubToken,
  type Fetcher,
} from '@/lib/seo/yandex-seo-report';
import { METRIKA_ID } from '@/lib/analytics/metrika';

const GOOD = 'y0_test_good_token_value_000';
const HTTPS = 'https:vedarai.ru:443';
const HTTP = 'http:vedarai.ru:80';

function json(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body };
}

/** Подставная сеть: отвечает по пути и записывает, что звали и с каким токеном. */
function fakeApi(opts: { httpsNotLoaded?: boolean; metrikaForbidden?: boolean; noTokenUser?: boolean } = {}) {
  const calls: Array<{ url: string; auth: string }> = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    if (init.headers.Authorization !== `OAuth ${GOOD}`) {
      return json(401, { error_code: 'INVALID_OAUTH_TOKEN', error_message: 'OAuth token is invalid' });
    }
    if (url.endsWith('/v4/user') || url.endsWith('/v4/user/')) {
      return json(200, { user_id: EXPECTED_USER_ID });
    }
    if (url.includes('/v4/user/') && url.endsWith('/hosts')) {
      return json(200, {
        hosts: [
          { host_id: 'https:other.ru:443', ascii_host_url: 'https://other.ru/', verified: true },
          { host_id: HTTP, ascii_host_url: 'http://vedarai.ru/', verified: true },
          { host_id: HTTPS, ascii_host_url: 'https://vedarai.ru/', verified: true },
        ],
      });
    }
    const hostPart = (id: string) => `/hosts/${encodeURIComponent(id)}`;
    if (url.includes(hostPart(HTTPS)) && !url.includes('/summary') && !url.includes('/sqi') && !url.includes('/search') && !url.includes('/sitemaps') && !url.includes('/recrawl')) {
      return opts.httpsNotLoaded
        ? json(200, { host_id: HTTPS, verified: true, ascii_host_url: 'https://vedarai.ru/', host_data_status: 'NOT_LOADED', main_mirror: null })
        : json(200, { host_id: HTTPS, verified: true, ascii_host_url: 'https://vedarai.ru/', host_data_status: 'OK', main_mirror: null });
    }
    if (url.includes(hostPart(HTTP)) && !url.includes('/summary') && !url.includes('/sqi') && !url.includes('/search') && !url.includes('/sitemaps') && !url.includes('/recrawl')) {
      return json(200, { host_id: HTTP, verified: true, ascii_host_url: 'http://vedarai.ru/', host_data_status: 'OK', main_mirror: null });
    }
    if (url.includes('/summary')) {
      if (opts.httpsNotLoaded && url.includes(hostPart(HTTPS))) {
        return json(404, { error_code: 'HOST_NOT_LOADED', error_message: 'Host is not loaded in Ya.Webmaster yet', host_id: HTTPS });
      }
      return json(200, { sqi: 0, searchable_pages_count: 0, excluded_pages_count: 0, site_problems: { RECOMMENDATION: 2 } });
    }
    if (url.includes('/sqi-history')) {
      if (opts.httpsNotLoaded && url.includes(hostPart(HTTPS))) {
        return json(404, { error_code: 'HOST_NOT_LOADED', error_message: 'Host is not loaded in Ya.Webmaster yet' });
      }
      return json(200, { points: [{ date: '2026-11-20T00:00:00+0300', value: 0 }] });
    }
    if (url.includes('/search-urls/in-search/history')) {
      if (opts.httpsNotLoaded && url.includes(hostPart(HTTPS))) {
        return json(404, { error_code: 'HOST_NOT_LOADED', error_message: 'Host is not loaded in Ya.Webmaster yet' });
      }
      return json(200, { history: [{ date: '2026-11-20T00:00:00+0300', value: 0 }] });
    }
    if (url.includes('/sitemaps')) {
      return json(200, {
        sitemaps: [{
          sitemap_url: 'https://vedarai.ru/sitemap.xml',
          last_access_date: '2026-10-09T06:33:00+0300',
          urls_count: 903,
          errors_count: 0,
          sources: ['ROBOTS_TXT'],
        }],
      });
    }
    if (url.includes('/recrawl/queue')) {
      return json(200, {
        tasks: [
          { url: 'https://vedarai.ru/plans', state: 'DONE', added_time: '2026-11-27T00:00:00+0300' },
          { url: 'https://vedarai.ru/fish', state: 'IN_PROGRESS', added_time: '2026-11-27T00:00:00+0300' },
        ],
      });
    }
    if (url.includes('/search-queries/popular')) {
      if (opts.httpsNotLoaded && url.includes(hostPart(HTTPS))) {
        return json(404, { error_code: 'HOST_NOT_LOADED', error_message: 'Host is not loaded in Ya.Webmaster yet' });
      }
      return json(200, {
        count: 1,
        date_from: '2026-11-20',
        date_to: '2026-11-26',
        queries: [{ query_text: 'туры на камчатку', indicators: { TOTAL_SHOWS: 4, TOTAL_CLICKS: 1, AVG_SHOW_POSITION: 8.0 } }],
      });
    }
    if (url.includes('/management/v1/counter/')) {
      if (opts.metrikaForbidden) {
        return json(403, {
          code: 403,
          message: 'Access is denied',
          errors: [{ error_type: 'access_denied', message: 'Access is denied' }],
        });
      }
      return json(200, { goals: [{ id: 694878914, name: 'Вовлечённый визит 60 сек' }] });
    }
    if (url.includes('/stat/v1/data')) {
      if (opts.metrikaForbidden) {
        return json(403, { code: 403, message: 'Access is denied', errors: [{ error_type: 'access_denied', message: 'Access is denied' }] });
      }
      const u = new URL(url);
      const dimensions = u.searchParams.get('dimensions') ?? '';
      const metrics = u.searchParams.get('metrics') ?? '';
      if (metrics.includes('goal694878914reaches')) {
        return json(200, { query: { date1: '2026-11-20', date2: '2026-11-27' }, totals: [3, 2], data: [] });
      }
      if (!dimensions) {
        return json(200, { query: { date1: '2026-11-20', date2: '2026-11-27' }, totals: [8, 6], data: [] });
      }
      if (dimensions.includes('lastTrafficSource')) {
        return json(200, { data: [{ dimensions: [{ name: 'Переходы из поисковых систем' }], metrics: [5, 4] }] });
      }
      if (dimensions.includes('lastSearchEngine')) {
        return json(200, { data: [{ dimensions: [{ name: 'Яндекс' }], metrics: [5, 4] }] });
      }
      if (dimensions.includes('startURLPath')) {
        return json(200, { data: [{ dimensions: [{ name: '/articles/zima' }], metrics: [2, 2] }] });
      }
      return json(200, { totals: [0, 0], data: [] });
    }
    return json(404, { error_code: 'NOT_FOUND', error_message: 'not found' });
  };
  return { fetcher, calls };
}

const TODAY = '2026-11-27';

describe('readToken и scrubToken', () => {
  it('берёт только непустой YANDEX_WEBMASTER_TOKEN', () => {
    expect(readToken({})).toEqual({ name: null, token: null });
    expect(readToken({ [TOKEN_ENV]: '   ' })).toEqual({ name: null, token: null });
    expect(readToken({ [TOKEN_ENV]: GOOD, YANDEX_OAUTH_TOKEN: 'other' })).toEqual({ name: TOKEN_ENV, token: GOOD });
  });

  it('вырезает значение токена из отчёта и не оставляет его в сводке', () => {
    const cleaned = scrubToken({ note: `token=${GOOD}` }, GOOD);
    expect(JSON.stringify(cleaned)).not.toContain(GOOD);
    expect(cleaned.note).toBe('token=***');
  });
});

describe('formatApiError', () => {
  it('складывает код HTTP, код ошибки и сообщение Яндекса', () => {
    expect(formatApiError({
      status: 404,
      error_code: 'HOST_NOT_LOADED',
      error_message: 'Host is not loaded in Ya.Webmaster yet',
      path: '/user/{u}/hosts/https:vedarai.ru:443/summary',
    })).toBe('HTTP 404 (HOST_NOT_LOADED): Host is not loaded in Ya.Webmaster yet на /user/{u}/hosts/https:vedarai.ru:443/summary');
  });
});

describe('collectYandexSeoReport', () => {
  it('без секрета не ходит в сеть и говорит, что токена нет', async () => {
    const { fetcher, calls } = fakeApi();
    const report = await collectYandexSeoReport({ env: {}, fetcher, today: TODAY, nowIso: '2026-11-27T04:00:00.000Z' });
    expect(calls).toEqual([]);
    expect(report.token.found).toBe(false);
    expect(reportOutcome(report)).toEqual({ level: 'error', message: `секрет ${TOKEN_ENV} не задан в Actions secrets` });
    expect(renderReportMarkdown(report)).toContain('YANDEX_WEBMASTER_TOKEN');
    expect(renderReportMarkdown(report)).not.toContain(GOOD);
  });

  it('снимает оба хоста и Метрику; чужой сайт аккаунта в сводку не попадает', async () => {
    const { fetcher, calls } = fakeApi();
    const report = await collectYandexSeoReport({
      env: { [TOKEN_ENV]: GOOD },
      fetcher,
      today: TODAY,
      nowIso: '2026-11-27T04:00:00.000Z',
    });
    expect(report.token).toEqual({ found: true, name: TOKEN_ENV });
    expect(report.webmaster.user_id).toBe(EXPECTED_USER_ID);
    expect(report.webmaster.hosts_in_account).toBe(3);
    expect(report.webmaster.our_hosts_found).toEqual([HTTP, HTTPS]);
    expect(report.webmaster.hosts.map((h) => h.host_id)).toEqual([...REPORT_HOST_IDS]);

    const https = report.webmaster.hosts[0];
    expect(https.info.ok && https.info.data.host_data_status).toBe('OK');
    expect(https.summary.ok && https.summary.data.sqi).toBe(0);
    expect(https.queries.ok && https.queries.data.top[0]).toEqual({
      query: 'туры на камчатку', shows: 4, clicks: 1, show_pos: 8, click_pos: null,
    });
    expect(https.sitemaps.ok && https.sitemaps.data.sitemaps[0].urls_count).toBe(903);
    expect(https.recrawl_queue.ok && https.recrawl_queue.data.by_state).toEqual({ DONE: 1, IN_PROGRESS: 1 });

    const week = report.metrika.windows.find((w) => w.key === '7d');
    expect(week?.totals.ok && week.totals.data.visits).toBe(8);
    expect(week?.sources.ok && week.sources.data.rows[0].name).toBe('Переходы из поисковых систем');
    expect(week?.search_engines.ok && week.search_engines.data.rows[0].name).toBe('Яндекс');
    expect(week?.landings.ok && week.landings.data.rows[0].name).toBe('/articles/zima');
    expect(week?.goals.ok && week.goals.data.rows[0]).toEqual({
      id: 694878914, name: 'Вовлечённый визит 60 сек', reaches: 3, users: 2,
    });

    const md = renderReportMarkdown(report);
    expect(md).toContain('https:vedarai.ru:443');
    expect(md).toContain('http:vedarai.ru:80');
    expect(md).toContain('туры на камчатку');
    expect(md).toContain('Переходы из поисковых систем');
    expect(md).not.toContain('other.ru');
    expect(md).not.toContain(GOOD);
    expect(reportOutcome(report).level).toBe('ok');

    expect(calls.every((c) => c.auth === `OAuth ${GOOD}`)).toBe(true);
    expect(calls.some((c) => c.url.includes('/user/') && c.url.includes(encodeURIComponent(HTTPS)))).toBe(true);
    expect(calls.some((c) => c.url.includes('/user/') && c.url.includes(encodeURIComponent(HTTP)))).toBe(true);
    expect(calls.some((c) => c.url.includes(`ids=${METRIKA_ID}`))).toBe(true);
  });

  it('для незагруженного https-хоста пишет точное сообщение API и не выдаёт отказ за ноль', async () => {
    const { fetcher } = fakeApi({ httpsNotLoaded: true });
    const report = await collectYandexSeoReport({ env: { [TOKEN_ENV]: GOOD }, fetcher, today: TODAY });
    const https = report.webmaster.hosts.find((h) => h.host_id === HTTPS)!;
    expect(https.info.ok && https.info.data.host_data_status).toBe('NOT_LOADED');
    expect(https.summary.ok).toBe(false);
    if (!https.summary.ok) {
      expect(https.summary.error_code).toBe('HOST_NOT_LOADED');
      expect(https.summary.error_message).toBe('Host is not loaded in Ya.Webmaster yet');
    }
    const md = renderReportMarkdown(report);
    expect(md).toContain('HTTP 404 (HOST_NOT_LOADED): Host is not loaded in Ya.Webmaster yet');
    expect(md).toMatch(/статус загрузки: `NOT_LOADED`/);
    // HTTP-хост при этом читается как обычно.
    const http = report.webmaster.hosts.find((h) => h.host_id === HTTP)!;
    expect(http.summary.ok && http.summary.data.searchable_pages_count).toBe(0);
    expect(reportOutcome(report).level).toBe('warning');
  });

  it('отказ Метрики по правам записывает точным текстом API и не выдумывает визиты', async () => {
    const { fetcher } = fakeApi({ metrikaForbidden: true });
    const report = await collectYandexSeoReport({ env: { [TOKEN_ENV]: GOOD }, fetcher, today: TODAY });
    expect(report.webmaster.user_id).toBe(EXPECTED_USER_ID);
    expect(report.metrika.goals_list.ok).toBe(false);
    if (!report.metrika.goals_list.ok) {
      expect(report.metrika.goals_list.status).toBe(403);
      expect(report.metrika.goals_list.error_message).toBe('Access is denied');
    }
    const md = renderReportMarkdown(report);
    expect(md).toContain('HTTP 403 (access_denied): Access is denied');
    expect(md).not.toMatch(/визиты: [1-9]/);
    expect(reportOutcome(report).level).toBe('warning');
  });

  it('непринятый токен краснеет с текстом API /user', async () => {
    const { fetcher } = fakeApi();
    const report = await collectYandexSeoReport({ env: { [TOKEN_ENV]: 'bad-token' }, fetcher, today: TODAY });
    expect(report.webmaster.user_id).toBeNull();
    const outcome = reportOutcome(report);
    expect(outcome.level).toBe('error');
    expect(outcome.message).toContain('INVALID_OAUTH_TOKEN');
    expect(outcome.message).toContain('OAuth token is invalid');
  });
});
