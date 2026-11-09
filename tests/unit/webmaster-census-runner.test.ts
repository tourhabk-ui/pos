/**
 * Перепись Вебмастера с раннера GitHub (09.11): токен ищется среди секретов
 * по списку имён и среди переменных репозитория, в журнал идёт сводка без
 * значений токена и без чужих сайтов аккаунта.
 *
 * Судится вызовом (окружение, сводка, исход) и разобранным workflow: какие
 * секреты он кладёт и что каждый из них перепись действительно пробует.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { webmasterCensus, tokenCandidates, type Fetcher, type CensusResult } from '@/lib/seo/webmaster-census';
import { runnerEnv, censusDigest, censusOutcome, SECRET_PREFIX } from '@/lib/seo/webmaster-census-report';

const GOOD = 'y0_runner_good_token_000';
const HOST_ID = 'https:vedarai.ru:443';

function fakeApi(opts: { withSite?: boolean } = {}): Fetcher {
  const withSite = opts.withSite ?? true;
  return async (url, init) => {
    const path = url.replace('https://api.webmaster.yandex.net/v4', '');
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
    if (init.headers.Authorization !== `OAuth ${GOOD}`) return json(401, { error_code: 'INVALID_OAUTH_TOKEN' });
    if (path === '/user') return json(200, { user_id: 7 });
    if (path === '/user/7/hosts') {
      return json(200, { hosts: [
        { host_id: 'https:secret-side-project.ru:443', ascii_host_url: 'https://secret-side-project.ru/', verified: true },
        ...(withSite ? [{ host_id: HOST_ID, ascii_host_url: 'https://vedarai.ru/', verified: true }] : []),
      ] });
    }
    const h = `/user/7/hosts/${encodeURIComponent(HOST_ID)}`;
    if (path === `${h}/summary`) return json(200, { sqi: 20, searchable_pages_count: 140, excluded_pages_count: 900, site_problems: { CRITICAL: 0 } });
    if (path.startsWith(`${h}/search-queries/popular?`)) {
      return json(200, { count: 2, date_from: '2026-08-11', date_to: '2026-11-09', queries: [
        { query_text: 'туры | камчатка', indicators: { TOTAL_SHOWS: 12, TOTAL_CLICKS: 1, AVG_SHOW_POSITION: 18.25 } },
        { query_text: 'ведар', indicators: { TOTAL_SHOWS: 30, TOTAL_CLICKS: 20, AVG_SHOW_POSITION: 1, AVG_CLICK_POSITION: 1 } },
      ] });
    }
    if (path.startsWith(`${h}/search-urls/in-search/samples?`)) return json(200, { count: 140, samples: [{ url: 'https://vedarai.ru/catalog' }] });
    if (path.startsWith(`${h}/search-urls/events/samples?`)) {
      return json(200, { count: 3, samples: [
        { url: 'https://vedarai.ru/x', event: 'REMOVED_FROM_SEARCH', excluded_url_status: 'LOW_QUALITY' },
      ] });
    }
    return json(404, { error_code: 'NOT_FOUND' });
  };
}

const run = (env: Record<string, string>, fetcher = fakeApi()) =>
  webmasterCensus({ env, fetcher, today: '2026-11-09', days: 90, topQueries: 100 });

describe('runnerEnv: секреты по приставке', () => {
  it('берёт непустые секреты под своими именами, пустые и чужое окружение — нет', () => {
    expect(runnerEnv({
      [`${SECRET_PREFIX}YANDEX_WEBMASTER_TOKEN`]: GOOD,
      [`${SECRET_PREFIX}WEBMASTER_TOKEN`]: '',
      [`${SECRET_PREFIX}YANDEX_TOKEN`]: '  ',
      GITHUB_TOKEN: 'ghs_x',
      PATH: '/usr/bin',
    })).toEqual({ 'secrets.YANDEX_WEBMASTER_TOKEN': GOOD });
  });

  it('приставка источника не судится как имя: secrets.X пробуется, секрет приложения и ключ Облака — нет', () => {
    expect(tokenCandidates({
      'secrets.YANDEX_WEBMASTER_TOKEN': 'a',
      'secrets.YANDEX_CLIENT_SECRET': 'b',
      'secrets.YANDEX_API_KEY': 'c',
      'secrets.YA_WM_TOKEN': 'd',
    })).toEqual({
      candidates: ['secrets.YANDEX_WEBMASTER_TOKEN', 'secrets.YA_WM_TOKEN'],
      yandex_names: ['secrets.YANDEX_API_KEY', 'secrets.YANDEX_CLIENT_SECRET', 'secrets.YANDEX_WEBMASTER_TOKEN', 'secrets.YA_WM_TOKEN'],
    });
  });

  it('перепись находит токен в секрете и называет его с источником', async () => {
    const r = await run(runnerEnv({ [`${SECRET_PREFIX}YANDEX_WEBMASTER_TOKEN`]: GOOD }));
    expect(r.token.found_as).toBe('secrets.YANDEX_WEBMASTER_TOKEN');
    expect(censusOutcome(r)).toEqual({ level: 'ok', message: 'все разделы прочитаны' });
  });
});

describe('censusDigest: сводка для публичного журнала', () => {
  it('полная перепись: числа, причины, запросы по убыванию показов; ни токена, ни чужого сайта', async () => {
    const r = await run(runnerEnv({ [`${SECRET_PREFIX}YANDEX_OAUTH_TOKEN`]: GOOD }));
    const text = censusDigest(r, { topQueries: 100, examples: 5 }).join('\n');
    expect(text).toContain('Токен: принят — `secrets.YANDEX_OAUTH_TOKEN`.');
    expect(text).toContain('Сайт: https://vedarai.ru/ (права подтверждены); всего сайтов в аккаунте 2.');
    expect(text).toContain('- в поиске: 140');
    expect(text).toContain('- исключено: 900');
    expect(text).toContain('- LOW_QUALITY: 1 — https://vedarai.ru/x');
    // Порядок — по показам; разделитель таблицы в запросе не ломает строку.
    expect(text.indexOf('| ведар | 30 | 20 | 1 | 1 |')).toBeGreaterThan(-1);
    expect(text.indexOf('| туры / камчатка | 12 | 1 | 18.3 | — |')).toBeGreaterThan(text.indexOf('| ведар |'));
    expect(text).not.toContain(GOOD);
    expect(text).not.toContain('secret-side-project');
    expect(JSON.stringify(r)).not.toContain('secret-side-project');
  });

  it('токена нет — сказано, что ни один секрет не задан, исход красный', async () => {
    const r = await run(runnerEnv({ [`${SECRET_PREFIX}WEBMASTER_TOKEN`]: '' }));
    const text = censusDigest(r, { topQueries: 10, examples: 3 }).join('\n');
    expect(text).toContain('Токен: **не найден или не принят**.');
    expect(text).toContain('- ни один из проверенных секретов не задан — у токена другое имя');
    expect(censusOutcome(r).level).toBe('error');
  });

  it('есть только ключ Облака — он назван именем, значение нет, к API не посылается', async () => {
    const calls: string[] = [];
    const api = fakeApi();
    const r = await run(runnerEnv({ [`${SECRET_PREFIX}YANDEX_API_KEY`]: 'gpt-secret' }), async (url, init) => {
      calls.push(url);
      return api(url, init);
    });
    const text = censusDigest(r, { topQueries: 10, examples: 3 }).join('\n');
    expect(text).toContain('`secrets.YANDEX_API_KEY`');
    expect(text).not.toContain('gpt-secret');
    expect(calls).toEqual([]);
  });

  it('токен не принят — причина названа кодом Яндекса, значение — нет', async () => {
    const r = await run(runnerEnv({ [`${SECRET_PREFIX}YANDEX_WEBMASTER_TOKEN`]: 'y0_wrong' }));
    const text = censusDigest(r, { topQueries: 10, examples: 3 }).join('\n');
    expect(text).toContain('- проверен `secrets.YANDEX_WEBMASTER_TOKEN`: HTTP 401 (INVALID_OAUTH_TOKEN) на /user');
    expect(text).not.toContain('y0_wrong');
  });

  it('нашего сайта нет в аккаунте — сказано словами и красный', async () => {
    const r = await run(runnerEnv({ [`${SECRET_PREFIX}WEBMASTER`]: GOOD }), fakeApi({ withSite: false }));
    const text = censusDigest(r, { topQueries: 10, examples: 3 }).join('\n');
    expect(text).toContain('Сайты аккаунта: 1, **нашего среди них нет**');
    expect(censusOutcome(r)).toEqual({ level: 'error', message: 'нашего сайта нет в аккаунте Вебмастера этого токена' });
  });

  it('часть разделов не прочиталась — жёлтый, все — красный', () => {
    const base: CensusResult = {
      token: { found_as: 'secrets.X', tried: [], yandex_names: [] },
      hosts: { ok: true, data: { total: 1, site: { url: 'https://vedarai.ru/', verified: true } } },
      host_id: HOST_ID,
      summary: { ok: false, error: 'HTTP 500' },
      queries: { ok: true, data: { date_from: null, date_to: null, total: 0, top: [] } },
      in_search: { ok: false, error: 'HTTP 500' },
      excluded: { ok: false, error: 'HTTP 500' },
    };
    expect(censusOutcome(base)).toEqual({ level: 'warning', message: 'не прочитались разделы: 3 из 4' });
    expect(censusOutcome({ ...base, queries: { ok: false, error: 'HTTP 500' } }).level).toBe('error');
    expect(censusDigest(base, { topQueries: 5, examples: 2 }).join('\n')).toContain('### Сводка\n**Не прочиталась** — HTTP 500.');
  });
});

describe('workflow переписи', () => {
  const FILE = '.github/workflows/webmaster-census.yml';
  const src = readFileSync(FILE, 'utf8');
  const wf = load(src) as {
    on: { push: { paths: string[] } };
    permissions: Record<string, string>;
    jobs: { census: { steps: Array<{ name?: string; env?: Record<string, string>; run?: string }> } };
  };
  const step = wf.jobs.census.steps.find((s) => s.name === 'Перепись')!;

  it('каждый секрет кладётся под своим именем, и перепись его пробует', () => {
    const mapped = Object.entries(step.env ?? {}).filter(([k]) => k.startsWith(SECRET_PREFIX));
    expect(mapped.length).toBeGreaterThan(10);
    for (const [key, value] of mapped) {
      const name = key.slice(SECRET_PREFIX.length);
      expect(value, key).toBe(`\${{ secrets.${name} }}`);
      expect(tokenCandidates({ [`secrets.${name}`]: 'v' }).candidates, `${name} не пробуется переписью — строка бесполезна`)
        .toEqual([`secrets.${name}`]);
    }
  });

  it('все секреты шагу не отдаются, переменные в окружение не кладутся; права — только чтение кода', () => {
    // Комментарий workflow объясняет, почему так нельзя, — судится код, не он.
    const code = src.replace(/^[ \t]*#.*$/gm, '');
    expect(code).not.toMatch(/toJSON\(\s*secrets\s*\)/);
    // Окружение шага печатается в публичный журнал, а vars не маскируются.
    expect(code).not.toMatch(/\bvars\./);
    expect(code).not.toMatch(/toJSON\(\s*vars\s*\)/);
    expect(wf.permissions).toEqual({ contents: 'read' });
  });

  it('маркер существует и запускает workflow; скрипт читает его', () => {
    const marker = '.github/triggers/webmaster-census.json';
    expect(wf.on.push.paths).toEqual([marker]);
    expect(step.run).toBe(`npx tsx scripts/webmaster-census.ts ${marker}`);
    const m = JSON.parse(readFileSync(marker, 'utf8')) as Record<string, unknown>;
    expect(typeof m.run).toBe('number');
  });
});
