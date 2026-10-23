/**
 * Чтение постов X напрямую через X API v2 (решение владельца 23.10: ключ X
 * Developer добавлен в секреты GitHub и переменные Timeweb — «читать ленту»).
 *
 * До этого дня посты X разведчик получал через xAI (`x_search`,
 * lib/ai/xai-x-search): модель искала и пересказывала. Боевой прогон 29.09
 * дал «0 постов за 14 ч» при 4 с работы — поиск молчал, и по нулю было не
 * назвать причину. Прямое чтение отдаёт сами посты: текст, дату, адрес — без
 * модели между нами и источником; ноль здесь значит «за окно не писали».
 *
 * ЗОВЁТСЯ С РАННЕРА GitHub (scripts/scout-x-fetch.ts через
 * lib/x/scout-x-read), как и xAI: с прода api.x.ai закрыт по региону, а
 * достижимость api.x.com с Timeweb не проверена — путь остаётся один,
 * прежний. Прод получает результат телом запроса разведчика и проверяет
 * его заново (xSearchResultFromRunner).
 *
 * Ключ. В портале разработчика X выдаются «API Key» и «API Key Secret»
 * (ключи приложения) и отдельно «Bearer Token» (чтение от имени приложения).
 * Читать можно любым из двух способов: bearer — как есть; пара ключ+секрет —
 * обменом на bearer (`POST /oauth2/token`, client_credentials). Имена
 * переменных — X_BEARER_TOKEN либо X_API_KEY и X_API_KEY_SECRET. X_API_KEY
 * без секрета пробуется как bearer: владелец назвал ключ «X API KEY», а в
 * портале так подписан не bearer — попробовать честнее, чем молча отказать;
 * отказ X всё равно будет назван.
 *
 * Один запрос на прогон: `GET /2/tweets/search/recent` с `from:` по всем
 * аккаунтам, без ретвитов и ответов, окно — start_time. Исходов три (§4.0):
 * посты (в том числе ноль), отказ словами (нет ключа, ключ не принят, тариф
 * без чтения, месячный лимит, сеть) — и никогда пустой список вместо
 * отказа. Тариф не угадывается: что разрешено ключу, говорит ответ X, и его
 * слова цитируются в причине.
 *
 * ПД здесь нет: аккаунты — лаборатории ИИ, тексты — их публичные посты.
 * Хост api.x.com — не LLM, промпта нет, в реестр D2 не входит.
 */
import type { XPost, XSearchDiag, XSearchResult } from '@/lib/ai/xai-x-search';

export const X_API_BASE = 'https://api.x.com';
export const X_ENV_BEARER = 'X_BEARER_TOKEN';
export const X_ENV_KEY = 'X_API_KEY';
export const X_ENV_SECRET = 'X_API_KEY_SECRET';
/** Подпись пути в результате: прод и отчёт видят, откуда посты. */
export const X_API_MODEL_LABEL = 'x-api-v2:search/recent';
/** Потолок длины запроса search/recent на базовом тарифе X (по документации; выше — Pro). */
export const X_QUERY_MAX_LEN = 512;
/** search/recent отдаёт за один запрос не больше ста постов. */
export const X_MAX_RESULTS = 100;

export type XCredentials =
  | { kind: 'bearer'; token: string; from: string }
  | { kind: 'app'; key: string; secret: string; from: string }
  | { kind: 'none' };

/**
 * Какие переменные заданы — имена, не значения: `from` уходит в лог и в
 * причину отказа, значение ключа — никуда. Чистая функция — под тестом.
 */
export function readXCredentials(env: Record<string, string | undefined> = process.env): XCredentials {
  const bearer = env[X_ENV_BEARER]?.trim();
  const key = env[X_ENV_KEY]?.trim();
  const secret = env[X_ENV_SECRET]?.trim();
  if (bearer) return { kind: 'bearer', token: bearer, from: X_ENV_BEARER };
  if (key && secret) return { kind: 'app', key, secret, from: `${X_ENV_KEY}+${X_ENV_SECRET}` };
  if (key) return { kind: 'bearer', token: key, from: `${X_ENV_KEY} (без секрета — как bearer)` };
  return { kind: 'none' };
}

/** Запрос search/recent: только посты самих аккаунтов, без ретвитов и ответов. */
export function buildXQuery(handles: readonly string[]): string {
  const from = handles.map((h) => `from:${h.replace(/^@/, '').trim()}`).filter((f) => f !== 'from:').join(' OR ');
  return `(${from}) -is:retweet -is:reply`;
}

/** Начало окна для start_time: ISO без миллисекунд, как ждёт X. */
export function xApiStartTime(now: Date, hours: number): string {
  return new Date(now.getTime() - hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

interface SearchRecentResponse {
  data?: Array<{ id?: unknown; text?: unknown; created_at?: unknown; author_id?: unknown }>;
  includes?: { users?: Array<{ id?: unknown; username?: unknown }> };
  meta?: { result_count?: unknown; next_token?: unknown };
}

/**
 * Посты из ответа search/recent — по форме, без догадок. Имя аккаунта —
 * из includes.users по author_id; не нашлось — адрес вида x.com/i/status/<id>
 * (X сам переадресует на автора). Текст — как есть, пробелы сведены, до 200
 * знаков; записи без id или текста отбрасываются.
 */
export function postsFromSearchRecent(j: unknown): XPost[] {
  const o = (j ?? {}) as SearchRecentResponse;
  const users = new Map<string, string>();
  for (const u of Array.isArray(o.includes?.users) ? o.includes.users : []) {
    if (typeof u?.id === 'string' && typeof u?.username === 'string') users.set(u.id, u.username);
  }
  const out: XPost[] = [];
  const seen = new Set<string>();
  for (const t of Array.isArray(o.data) ? o.data : []) {
    const id = typeof t?.id === 'string' ? t.id : '';
    const text = typeof t?.text === 'string' ? t.text.replace(/\s+/g, ' ').trim() : '';
    if (!/^\d+$/.test(id) || text.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const handle = (typeof t.author_id === 'string' && users.get(t.author_id)) || 'i';
    const postedAt = typeof t.created_at === 'string' && !Number.isNaN(Date.parse(t.created_at))
      ? new Date(t.created_at).toISOString()
      : null;
    out.push({ handle, url: `https://x.com/${handle}/status/${id}`, postedAt, summary: text.slice(0, 200) });
  }
  return out;
}

/** Срез тела ответа для причины отказа — когда ответ не JSON или без знакомых полей. */
function excerpt(body: string): string {
  return body.replace(/\s+/g, ' ').slice(0, 160);
}

function detailOf(body: string): string {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(body) as Record<string, unknown>;
  } catch {
    // Не JSON (страница ошибки, пустое тело) — это не сбой разбора, а форма
    // ответа: в причину уходит срез тела как есть.
    return excerpt(body);
  }
  const parts = ['title', 'detail', 'reason'].map((k) => (typeof j[k] === 'string' ? (j[k] as string) : '')).filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : excerpt(body);
}

/**
 * Отказ X словами. 403 у X — чаще не «нет прав», а тариф или приложение вне
 * проекта: подсказка стоит рядом с цитатой ответа, а сам ответ цитируется
 * всегда — чинится это в портале разработчика, не в коде.
 */
export function nameXApiFailure(status: number, body: string, headers?: Headers | null): string {
  const detail = detailOf(body);
  if (status === 401) return `X API: ключ не принят (401) — ${detail}`;
  if (status === 402) return `X API: нужна оплата (402) — ${detail}`;
  if (status === 403) {
    const tier = /enrolled|subset|access level|elevated|project|product/i.test(body)
      ? ' — похоже, ключу не разрешено чтение: тариф и привязка приложения к проекту в портале разработчика'
      : '';
    return `X API: доступ закрыт (403) — ${detail}${tier}`;
  }
  if (status === 429) {
    if (/usage ?cap|monthly|product cap/i.test(body)) return `X API: месячный лимит чтения исчерпан (429) — ${detail}`;
    const reset = headers?.get('x-rate-limit-reset');
    const at = reset && /^\d+$/.test(reset) ? new Date(Number(reset) * 1000).toISOString() : null;
    return `X API: слишком много запросов (429)${at ? `, окно откроется ${at}` : ''}`;
  }
  return `X API: HTTP ${status} — ${detail}`;
}

type Fetch = typeof fetch;

async function bearerFromAppKeys(
  key: string, secret: string, timeoutMs: number, doFetch: Fetch,
): Promise<{ token: string } | { error: string }> {
  const basic = Buffer.from(`${encodeURIComponent(key)}:${encodeURIComponent(secret)}`).toString('base64');
  let res: Response;
  try {
    res = await doFetch(`${X_API_BASE}/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { error: `X API: сеть не дошла (oauth2/token) — ${e instanceof Error ? e.message : String(e)}` };
  }
  const body = await res.text();
  if (!res.ok) return { error: nameXApiFailure(res.status, body, res.headers).replace('X API:', 'X API (обмен ключа на bearer):') };
  let j: { access_token?: unknown };
  try {
    j = JSON.parse(body) as { access_token?: unknown };
  } catch {
    return { error: `X API (обмен ключа на bearer): ответ не JSON — ${excerpt(body)}` };
  }
  if (typeof j.access_token === 'string' && j.access_token) return { token: j.access_token };
  return { error: 'X API (обмен ключа на bearer): в ответе нет access_token' };
}

export interface XApiReadOptions {
  handles: readonly string[];
  hours: number;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  now?: Date;
  /** Подмена сети под тестом. */
  fetchImpl?: Fetch;
}

/**
 * Посты аккаунтов за окно часов — одним запросом search/recent.
 * Больше ста постов за окно — `diag.truncated`: сказано, а не потеряно.
 */
export async function readXViaApi(opts: XApiReadOptions): Promise<XSearchResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const creds = readXCredentials(opts.env ?? process.env);
  if (creds.kind === 'none') return { ok: false, reason: `X API: ключ не задан (${X_ENV_BEARER} или ${X_ENV_KEY}+${X_ENV_SECRET})` };
  if (opts.handles.length === 0) return { ok: false, reason: 'список аккаунтов пуст' };

  const query = buildXQuery(opts.handles);
  if (query.length > X_QUERY_MAX_LEN) {
    return { ok: false, reason: `X API: запрос длиннее ${X_QUERY_MAX_LEN} знаков (${query.length}) — аккаунтов слишком много для одного запроса` };
  }

  let token: string;
  if (creds.kind === 'bearer') {
    token = creds.token;
  } else {
    const got = await bearerFromAppKeys(creds.key, creds.secret, timeoutMs, doFetch);
    if ('error' in got) return { ok: false, reason: got.error };
    token = got.token;
  }

  const params = new URLSearchParams({
    query,
    max_results: String(X_MAX_RESULTS),
    start_time: xApiStartTime(opts.now ?? new Date(), opts.hours),
    'tweet.fields': 'created_at,author_id',
    expansions: 'author_id',
    'user.fields': 'username',
  });
  const started = Date.now();
  let res: Response;
  try {
    res = await doFetch(`${X_API_BASE}/2/tweets/search/recent?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, reason: `X API: сеть не дошла — ${e instanceof Error ? e.message : String(e)}` };
  }
  const body = await res.text();
  if (!res.ok) return { ok: false, reason: nameXApiFailure(res.status, body, res.headers) };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'X API: ответ не JSON' };
  }
  const posts = postsFromSearchRecent(parsed);
  const meta = ((parsed ?? {}) as SearchRecentResponse).meta ?? {};
  const remaining = res.headers.get('x-rate-limit-remaining');
  const reset = res.headers.get('x-rate-limit-reset');
  const diag: XSearchDiag = {
    searchCalls: 1,
    requests: 1,
    source: 'x_api',
    credentialsFrom: creds.from,
    ...(typeof meta.next_token === 'string' ? { truncated: true } : {}),
    ...(remaining && /^\d+$/.test(remaining)
      ? { rateLimit: { remaining: Number(remaining), resetAt: reset && /^\d+$/.test(reset) ? new Date(Number(reset) * 1000).toISOString() : null } }
      : {}),
    ...(posts.length === 0 ? { emptyAnswerHead: `X API: result_count ${typeof meta.result_count === 'number' ? meta.result_count : '?'}` } : {}),
  };
  return { ok: true, model: X_API_MODEL_LABEL, posts, usage: null, ms: Date.now() - started, diag };
}
