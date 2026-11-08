/**
 * Перепись Яндекс Вебмастера для vedarai.ru — только чтение (08.11).
 *
 * Пункт 1 плана SEO владельца: что проиндексировано, что исключено и почему,
 * по каким запросам уже есть показы. Без этих чисел причина низкой видимости
 * — догадка. Владелец 08.11: «токен вебмастера в переменных должен быть» —
 * имя переменной в репозитории не записано нигде, поэтому её ищут по имени
 * среди переменных окружения прода и называют найденное ИМЕНЕМ: значение
 * токена не попадает в ответ ни при каком исходе.
 *
 * API: https://api.webmaster.yandex.net/v4, заголовок `Authorization: OAuth
 * <токен>`. Методы — по справке Яндекса (08.11): /user, /user/{u}/hosts,
 * …/summary, …/search-queries/popular, …/search-urls/in-search/samples,
 * …/search-urls/events/samples.
 *
 * Каждый раздел — данные или отказ словами (§4.0): «не прочиталось» не
 * выдаётся за «пусто».
 */

export const WEBMASTER_API = 'https://api.webmaster.yandex.net/v4';
export const SITE_HOST = 'vedarai.ru';

/** Имя прямо про Вебмастер — такие пробуются первыми. */
const WEBMASTER_NAME = /WEBMASTER|WEB_MASTER|YA_?WM/i;
/**
 * Прочие токены Яндекса (OAuth Метрики, Директа и т.п. — один аккаунт может
 * давать и права Вебмастера). Секреты приложений, пароли и ключи моделей сюда
 * не попадают: их в API Вебмастера не посылаем.
 */
const YANDEX_TOKEN_NAME = /YANDEX.*TOKEN|TOKEN.*YANDEX|YANDEX.*OAUTH/i;
const NOT_A_TOKEN = /SECRET|PASSWORD|CLIENT_ID|API_KEY|FOLDER/i;
/** Имена, которые показываются для подсказки: всё про Яндекс (только имена). */
const YANDEX_NAME = /YANDEX|WEBMASTER|^YA_/i;

export interface TokenCandidates {
  /** Имена с непустым значением, похожие на токен Вебмастера, — в порядке проверки. */
  candidates: string[];
  /** Все имена про Яндекс (без значений) — чтобы назвать, что есть, если токена не нашлось. */
  yandex_names: string[];
}

/** Кандидаты в токен по ИМЕНАМ переменных. Значения наружу не уходят. */
export function tokenCandidates(env: Record<string, string | undefined>): TokenCandidates {
  const names = Object.keys(env).sort();
  return {
    candidates: [
      ...names.filter((n) => WEBMASTER_NAME.test(n)),
      ...names.filter((n) => !WEBMASTER_NAME.test(n) && YANDEX_TOKEN_NAME.test(n)),
    ].filter((n) => !NOT_A_TOKEN.test(n) && (env[n] ?? '').trim().length > 0),
    yandex_names: names.filter((n) => YANDEX_NAME.test(n)),
  };
}

export type Section<T> = { ok: true; data: T } | { ok: false; error: string };

export type Fetcher = (url: string, init: { headers: Record<string, string> }) => Promise<{
  ok: boolean; status: number; json: () => Promise<unknown>;
}>;

/** Ошибка API словами: код ответа и код ошибки Яндекса, без тела запроса. */
async function call(fetcher: Fetcher, token: string, path: string): Promise<unknown> {
  const res = await fetcher(`${WEBMASTER_API}${path}`, {
    headers: { Authorization: `OAuth ${token}`, Accept: 'application/json' },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const code = body && typeof body === 'object' && 'error_code' in body
      ? String((body as { error_code: unknown }).error_code) : 'нет кода';
    throw new Error(`HTTP ${res.status} (${code}) на ${path.replace(/\/user\/\d+/, '/user/{u}')}`);
  }
  return body;
}

async function section<T>(run: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

interface ApiHost { host_id: string; ascii_host_url: string; verified?: boolean; main_mirror?: unknown }
interface ApiQuery { query_text: string; indicators?: Record<string, number | null> }
interface ApiEvent { url: string; event: string; excluded_url_status?: string; bad_http_status?: number; event_date?: string }

/** Сводка исключений: сколько страниц по каждой причине и по образцу на причину. */
export function excludedByReason(samples: ApiEvent[]): Array<{ reason: string; count: number; examples: string[] }> {
  const map = new Map<string, string[]>();
  for (const s of samples) {
    if (s.event !== 'REMOVED_FROM_SEARCH') continue;
    const reason = s.excluded_url_status
      ? (s.bad_http_status ? `${s.excluded_url_status} ${s.bad_http_status}` : s.excluded_url_status)
      : 'не названа';
    map.set(reason, [...(map.get(reason) ?? []), s.url]);
  }
  return [...map.entries()]
    .map(([reason, urls]) => ({ reason, count: urls.length, examples: urls.slice(0, 5) }))
    .sort((a, b) => b.count - a.count);
}

/** Запросы с показами: текст, показы, клики, средние позиции — по убыванию показов. */
export function queryRows(queries: ApiQuery[], limit: number) {
  return queries
    .map((q) => ({
      query: q.query_text,
      shows: q.indicators?.TOTAL_SHOWS ?? null,
      clicks: q.indicators?.TOTAL_CLICKS ?? null,
      show_pos: q.indicators?.AVG_SHOW_POSITION ?? null,
      click_pos: q.indicators?.AVG_CLICK_POSITION ?? null,
    }))
    .sort((a, b) => (b.shows ?? 0) - (a.shows ?? 0))
    .slice(0, limit);
}

export interface CensusResult {
  token: { found_as: string | null; tried: Array<{ name: string; result: string }>; yandex_names: string[] };
  hosts?: Section<Array<{ url: string; verified: boolean | null }>>;
  host_id?: string | null;
  summary?: Section<unknown>;
  queries?: Section<{ date_from: unknown; date_to: unknown; total: unknown; top: ReturnType<typeof queryRows> }>;
  in_search?: Section<{ total: unknown; urls: string[] }>;
  excluded?: Section<{ events_total: unknown; removed_in_sample: number; by_reason: ReturnType<typeof excludedByReason> }>;
}

/**
 * Перепись целиком. `env` — переменные окружения, `fetcher` — сеть,
 * `today` — YYYY-MM-DD; окно запросов — `days` дней до `today`.
 */
export async function webmasterCensus(opts: {
  env: Record<string, string | undefined>;
  fetcher: Fetcher;
  today: string;
  days: number;
  topQueries: number;
}): Promise<CensusResult> {
  const { candidates, yandex_names } = tokenCandidates(opts.env);
  const tried: Array<{ name: string; result: string }> = [];
  let token: string | null = null;
  let foundAs: string | null = null;
  let userId: number | null = null;

  for (const name of candidates) {
    try {
      const body = await call(opts.fetcher, String(opts.env[name]).trim(), '/user') as { user_id?: number };
      if (typeof body?.user_id === 'number') {
        token = String(opts.env[name]).trim();
        foundAs = name;
        userId = body.user_id;
        tried.push({ name, result: 'принят' });
        break;
      }
      tried.push({ name, result: 'ответ без user_id' });
    } catch (e) {
      tried.push({ name, result: e instanceof Error ? e.message : String(e) });
    }
  }

  const result: CensusResult = { token: { found_as: foundAs, tried, yandex_names } };
  if (!token || userId === null) return result;

  const u = `/user/${userId}`;
  let hostId: string | null = null;
  result.hosts = await section(async () => {
    const body = await call(opts.fetcher, token!, `${u}/hosts`) as { hosts?: ApiHost[] };
    const hosts = body.hosts ?? [];
    const site = hosts.find((h) => new RegExp(`(^|//|:)(www\\.)?${SITE_HOST.replace('.', '\\.')}(:|/|$)`).test(h.ascii_host_url));
    hostId = site?.host_id ?? null;
    return hosts.map((h) => ({ url: h.ascii_host_url, verified: typeof h.verified === 'boolean' ? h.verified : null }));
  });
  result.host_id = hostId;
  if (!hostId) return result;

  const h = `${u}/hosts/${encodeURIComponent(hostId)}`;
  const from = new Date(`${opts.today}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - opts.days);
  const indicators = ['TOTAL_SHOWS', 'TOTAL_CLICKS', 'AVG_SHOW_POSITION', 'AVG_CLICK_POSITION']
    .map((i) => `query_indicator=${i}`).join('&');

  const [summary, queries, inSearch, excluded] = await Promise.all([
    section(() => call(opts.fetcher, token!, `${h}/summary`)),
    section(async () => {
      const body = await call(opts.fetcher, token!,
        `${h}/search-queries/popular?order_by=TOTAL_SHOWS&${indicators}&limit=500`
        + `&date_from=${encodeURIComponent(from.toISOString())}&date_to=${encodeURIComponent(`${opts.today}T00:00:00.000Z`)}`,
      ) as { queries?: ApiQuery[]; date_from?: unknown; date_to?: unknown; count?: unknown };
      return { date_from: body.date_from, date_to: body.date_to, total: body.count, top: queryRows(body.queries ?? [], opts.topQueries) };
    }),
    section(async () => {
      const body = await call(opts.fetcher, token!, `${h}/search-urls/in-search/samples?limit=100`) as { count?: unknown; samples?: Array<{ url: string }> };
      return { total: body.count, urls: (body.samples ?? []).map((s) => s.url) };
    }),
    section(async () => {
      const body = await call(opts.fetcher, token!, `${h}/search-urls/events/samples?limit=100`) as { count?: unknown; samples?: ApiEvent[] };
      const samples = body.samples ?? [];
      return {
        events_total: body.count,
        removed_in_sample: samples.filter((s) => s.event === 'REMOVED_FROM_SEARCH').length,
        by_reason: excludedByReason(samples),
      };
    }),
  ]);
  return { ...result, summary, queries, in_search: inSearch, excluded };
}
