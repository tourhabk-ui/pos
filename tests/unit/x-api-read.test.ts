// @vitest-environment node
/**
 * Разведчик читает X напрямую через X API ключом владельца (23.10), xAI —
 * запасной путь. Сторож держит связку: откуда ключ (имена, не значения),
 * форма запроса (только посты аккаунтов, без ретвитов и ответов, в потолок
 * длины), разбор ответа (адрес поста из id и имени автора), отказ словами с
 * цитатой ответа X (§4.0), выбор пути с названной причиной запасного и
 * сам скрипт раннера с его секретами в обоих workflow.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readXCredentials, buildXQuery, xApiStartTime, postsFromSearchRecent, nameXApiFailure, readXViaApi,
  X_QUERY_MAX_LEN, X_API_MODEL_LABEL, X_ENV_BEARER, X_ENV_KEY, X_ENV_SECRET,
} from '@/lib/x/x-api-read';
import { readXForScout } from '@/lib/x/scout-x-read';
import { X_HANDLES } from '@/lib/agents/scout-sources';
import type { XSearchResult } from '@/lib/ai/xai-x-search';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('откуда ключ', () => {
  it('bearer — как есть; имя переменной в from, значение — нет', () => {
    const c = readXCredentials({ X_BEARER_TOKEN: 'AAAAsecret' });
    expect(c).toMatchObject({ kind: 'bearer', token: 'AAAAsecret', from: X_ENV_BEARER });
    expect(c.kind === 'bearer' && c.from).not.toContain('secret');
  });
  it('пара ключ+секрет — обмен на bearer', () => {
    expect(readXCredentials({ X_API_KEY: 'k', X_API_KEY_SECRET: 's' })).toEqual({ kind: 'app', key: 'k', secret: 's', from: `${X_ENV_KEY}+${X_ENV_SECRET}` });
  });
  it('X_API_KEY без секрета пробуется как bearer — и это названо', () => {
    const c = readXCredentials({ X_API_KEY: 'AAAAbearer' });
    expect(c).toMatchObject({ kind: 'bearer', token: 'AAAAbearer' });
    expect(c.kind === 'bearer' && c.from).toMatch(/без секрета/);
  });
  it('bearer важнее пары; пустые строки — не ключ', () => {
    expect(readXCredentials({ X_BEARER_TOKEN: 'b', X_API_KEY: 'k', X_API_KEY_SECRET: 's' })).toMatchObject({ kind: 'bearer', from: X_ENV_BEARER });
    expect(readXCredentials({ X_BEARER_TOKEN: '  ', X_API_KEY: '' })).toEqual({ kind: 'none' });
  });
});

describe('запрос search/recent', () => {
  it('только посты самих аккаунтов: from: по каждому, без ретвитов и ответов', () => {
    const q = buildXQuery(['OpenAI', '@AnthropicAI']);
    expect(q).toBe('(from:OpenAI OR from:AnthropicAI) -is:retweet -is:reply');
  });
  it('список разведчика укладывается в потолок базового тарифа', () => {
    expect(buildXQuery(X_HANDLES).length).toBeLessThanOrEqual(X_QUERY_MAX_LEN);
  });
  it('начало окна — ISO без миллисекунд, на hours назад', () => {
    expect(xApiStartTime(new Date('2026-10-23T10:00:00.123Z'), 14)).toBe('2026-10-22T20:00:00Z');
  });
});

describe('разбор ответа', () => {
  const RESPONSE = {
    data: [
      { id: '1', text: 'Sonnet 5.5  is\nout', created_at: '2026-10-23T01:02:03.000Z', author_id: 'u1' },
      { id: '2', text: 'no author', created_at: 'bad-date' },
      { id: '1', text: 'дубль', author_id: 'u1' },
      { id: 'x', text: 'не id' },
      { id: '3', text: '   ' },
    ],
    includes: { users: [{ id: 'u1', username: 'AnthropicAI' }] },
    meta: { result_count: 5 },
  };
  it('адрес — из имени автора и id; текст как есть, пробелы сведены; без автора — x.com/i', () => {
    const posts = postsFromSearchRecent(RESPONSE);
    expect(posts).toEqual([
      { handle: 'AnthropicAI', url: 'https://x.com/AnthropicAI/status/1', postedAt: '2026-10-23T01:02:03.000Z', summary: 'Sonnet 5.5 is out' },
      { handle: 'i', url: 'https://x.com/i/status/2', postedAt: null, summary: 'no author' },
    ]);
  });
  it('текст режется до 200 знаков; мусор даёт пустой список, не исключение', () => {
    const long = postsFromSearchRecent({ data: [{ id: '9', text: 'a'.repeat(500), author_id: 'u' }] });
    expect(long[0].summary).toHaveLength(200);
    expect(postsFromSearchRecent(null)).toEqual([]);
    expect(postsFromSearchRecent({ data: 'nope' })).toEqual([]);
  });
});

describe('отказ словами', () => {
  it('401 — ключ не принят, с цитатой ответа', () => {
    expect(nameXApiFailure(401, '{"title":"Unauthorized","detail":"Unauthorized"}')).toBe('X API: ключ не принят (401) — Unauthorized · Unauthorized');
  });
  it('403 про тариф — подсказка про портал разработчика рядом с цитатой', () => {
    const r = nameXApiFailure(403, '{"title":"Client Forbidden","detail":"You currently have access to a subset of X API V2 endpoints","reason":"client-not-enrolled"}');
    expect(r).toMatch(/^X API: доступ закрыт \(403\) — Client Forbidden · You currently have access to a subset/);
    expect(r).toMatch(/тариф и привязка приложения к проекту/);
    expect(nameXApiFailure(403, 'Forbidden')).not.toMatch(/тариф/);
  });
  it('429: месячный лимит отличается от окна запросов, у окна — время открытия', () => {
    expect(nameXApiFailure(429, '{"title":"UsageCapExceeded","detail":"Usage cap exceeded: Monthly product cap"}')).toMatch(/^X API: месячный лимит чтения исчерпан \(429\)/);
    const h = new Headers({ 'x-rate-limit-reset': '1800000000' });
    expect(nameXApiFailure(429, '{"title":"Too Many Requests"}', h)).toBe('X API: слишком много запросов (429), окно откроется 2027-01-15T08:00:00.000Z');
  });
  it('прочее — код и цитата; не JSON — срез тела', () => {
    expect(nameXApiFailure(503, '<html>Service Unavailable</html>')).toBe('X API: HTTP 503 — <html>Service Unavailable</html>');
  });
});

function fetchOf(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as unknown as typeof fetch;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('вызов X API', () => {
  const OK = {
    data: [{ id: '10', text: 'Hello', created_at: '2026-10-23T00:00:00Z', author_id: 'u' }],
    includes: { users: [{ id: 'u', username: 'OpenAI' }] },
    meta: { result_count: 1 },
  };
  it('нет ключа — отказ словами с именами переменных, сеть не трогается', async () => {
    const f = fetchOf(() => json(OK));
    const r = await readXViaApi({ handles: ['OpenAI'], hours: 14, env: {}, fetchImpl: f });
    expect(r).toEqual({ ok: false, reason: `X API: ключ не задан (${X_ENV_BEARER} или ${X_ENV_KEY}+${X_ENV_SECRET})` });
    expect(f).not.toHaveBeenCalled();
  });
  it('bearer: один GET search/recent с запросом, окном и bearer; посты разобраны, лимит в диагностике', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const f = fetchOf((url, init) => { calls.push({ url, init }); return json(OK, 200, { 'x-rate-limit-remaining': '41', 'x-rate-limit-reset': '1800000000' }); });
    const r = await readXViaApi({ handles: ['OpenAI', 'xai'], hours: 14, env: { X_BEARER_TOKEN: 'tok' }, now: new Date('2026-10-23T10:00:00Z'), fetchImpl: f });
    expect(calls).toHaveLength(1);
    const u = new URL(calls[0].url);
    expect(u.origin + u.pathname).toBe('https://api.x.com/2/tweets/search/recent');
    expect(u.searchParams.get('query')).toBe('(from:OpenAI OR from:xai) -is:retweet -is:reply');
    expect(u.searchParams.get('start_time')).toBe('2026-10-22T20:00:00Z');
    expect(u.searchParams.get('max_results')).toBe('100');
    expect(u.searchParams.get('expansions')).toBe('author_id');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.model).toBe(X_API_MODEL_LABEL);
    expect(r.posts).toEqual([{ handle: 'OpenAI', url: 'https://x.com/OpenAI/status/10', postedAt: '2026-10-23T00:00:00.000Z', summary: 'Hello' }]);
    expect(r.diag).toMatchObject({ source: 'x_api', credentialsFrom: X_ENV_BEARER, requests: 1, rateLimit: { remaining: 41, resetAt: '2027-01-15T08:00:00.000Z' } });
    expect(r.diag?.truncated).toBeUndefined();
  });
  it('пара ключ+секрет: сначала обмен на bearer (Basic, client_credentials), потом чтение им', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const f = fetchOf((url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/oauth2/token')) return json({ token_type: 'bearer', access_token: 'granted' });
      return json(OK);
    });
    const r = await readXViaApi({ handles: ['OpenAI'], hours: 1, env: { X_API_KEY: 'k', X_API_KEY_SECRET: 's' }, fetchImpl: f });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/oauth2/token', '/2/tweets/search/recent']);
    const tokenInit = calls[0].init!;
    expect(tokenInit.method).toBe('POST');
    expect((tokenInit.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('k:s').toString('base64')}`);
    expect(tokenInit.body).toBe('grant_type=client_credentials');
    expect((calls[1].init?.headers as Record<string, string>).Authorization).toBe('Bearer granted');
    expect(r.ok).toBe(true);
  });
  it('тариф без чтения — отказ назван словами X, постов нет', async () => {
    const f = fetchOf(() => json({ title: 'Client Forbidden', detail: 'You currently have access to a subset of X API V2 endpoints', reason: 'client-not-enrolled' }, 403));
    const r = await readXViaApi({ handles: ['OpenAI'], hours: 14, env: { X_BEARER_TOKEN: 't' }, fetchImpl: f });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/^X API: доступ закрыт \(403\)/);
    expect(r.reason).toMatch(/client-not-enrolled/);
  });
  it('ноль постов — ok с формой ответа, не отказ; next_token — truncated', async () => {
    const empty = await readXViaApi({ handles: ['OpenAI'], hours: 14, env: { X_BEARER_TOKEN: 't' }, fetchImpl: fetchOf(() => json({ meta: { result_count: 0 } })) });
    expect(empty).toMatchObject({ ok: true, posts: [], diag: { emptyAnswerHead: 'X API: result_count 0' } });
    const more = await readXViaApi({ handles: ['OpenAI'], hours: 14, env: { X_BEARER_TOKEN: 't' }, fetchImpl: fetchOf(() => json({ ...OK, meta: { result_count: 100, next_token: 'n' } })) });
    expect(more.ok && more.diag?.truncated).toBe(true);
  });
  it('сеть не дошла и не JSON — отказы словами', async () => {
    const net = await readXViaApi({ handles: ['OpenAI'], hours: 14, env: { X_BEARER_TOKEN: 't' }, fetchImpl: fetchOf(() => { throw new Error('ECONNRESET'); }) });
    expect(net).toEqual({ ok: false, reason: 'X API: сеть не дошла — ECONNRESET' });
    const bad = await readXViaApi({ handles: ['OpenAI'], hours: 14, env: { X_BEARER_TOKEN: 't' }, fetchImpl: fetchOf(() => new Response('<html>', { status: 200 })) });
    expect(bad).toEqual({ ok: false, reason: 'X API: ответ не JSON' });
  });
});

describe('выбор пути для разведчика', () => {
  const okApi: XSearchResult = { ok: true, model: X_API_MODEL_LABEL, posts: [], usage: null, ms: 1, diag: { searchCalls: 1, requests: 1, source: 'x_api' } };
  const okXai: XSearchResult = { ok: true, model: 'grok-x', posts: [], usage: null, ms: 2, diag: { searchCalls: 2, requests: 1 } };
  const opts = { handles: ['OpenAI'], hours: 14 };

  it('ключ X задан и X API ответил — xAI не зовётся', async () => {
    const viaApi = vi.fn(async () => okApi);
    const viaXai = vi.fn(async () => okXai);
    const r = await readXForScout(opts, { viaApi, viaXai, env: { X_BEARER_TOKEN: 't' } });
    expect(r).toBe(okApi);
    expect(viaXai).not.toHaveBeenCalled();
  });
  it('X API отказал — посты от xAI, причина отказа X названа в диагностике', async () => {
    const viaApi = vi.fn(async (): Promise<XSearchResult> => ({ ok: false, reason: 'X API: доступ закрыт (403) — Client Forbidden' }));
    const viaXai = vi.fn(async () => okXai);
    const r = await readXForScout(opts, { viaApi, viaXai, env: { X_BEARER_TOKEN: 't' } });
    expect(r.ok && r.diag).toMatchObject({ source: 'xai', fallbackFrom: 'X API: доступ закрыт (403) — Client Forbidden', searchCalls: 2 });
  });
  it('ключа X нет — сразу xAI, и «ключ не задан» названо причиной, а не замолчано', async () => {
    const viaApi = vi.fn(async () => okApi);
    const viaXai = vi.fn(async () => okXai);
    const r = await readXForScout(opts, { viaApi, viaXai, env: {} });
    expect(viaApi).not.toHaveBeenCalled();
    expect(r.ok && r.diag?.fallbackFrom).toMatch(/^X API: ключ не задан/);
  });
  it('отказали оба — одна причина из двух частей', async () => {
    const viaApi = vi.fn(async (): Promise<XSearchResult> => ({ ok: false, reason: 'X API: ключ не принят (401) — Unauthorized' }));
    const viaXai = vi.fn(async (): Promise<XSearchResult> => ({ ok: false, reason: 'xAI: кредиты исчерпаны или достигнут лимит трат (403)' }));
    const r = await readXForScout(opts, { viaApi, viaXai, env: { X_API_KEY: 'k' } });
    expect(r).toEqual({ ok: false, reason: 'X API: ключ не принят (401) — Unauthorized; запасной путь xAI: xAI: кредиты исчерпаны или достигнут лимит трат (403)' });
  });
});

describe('связка: скрипт раннера и секреты workflow', () => {
  const SCRIPT = read('scripts/scout-x-fetch.ts');
  const DIGEST = read('.github/workflows/cron-scout-digest.yml');
  const PROBE = read('.github/workflows/scout-x-fetch-probe.yml');
  it('скрипт зовёт выбор пути, а не один из путей напрямую', () => {
    expect(SCRIPT).toContain("import { readXForScout } from '@/lib/x/scout-x-read'");
    expect(SCRIPT).toContain('readXForScout({ handles: X_HANDLES, hours: X_SEARCH_WINDOW_HOURS })');
    expect(SCRIPT).not.toMatch(/searchX\(|readXViaApi\(/);
  });
  it('оба workflow передают ключ X (bearer или пара) рядом с ключом xAI', () => {
    for (const wf of [DIGEST, PROBE]) {
      for (const name of [X_ENV_BEARER, X_ENV_KEY, X_ENV_SECRET, 'XAI_API_KEY']) {
        expect(wf).toContain(`${name}: \${{ secrets.${name} }}`);
      }
    }
  });
  it('читатель X не зовёт модели: промпта нет, хост не LLM', () => {
    const src = read('lib/x/x-api-read.ts');
    expect(src).not.toMatch(/from '@\/lib\/ai\/providers'|callAI|prompt/i);
    expect(src).toContain("'https://api.x.com'");
  });
});
