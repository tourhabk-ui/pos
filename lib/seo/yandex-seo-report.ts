/**
 * Еженедельный отчёт Яндекс Вебмастера и Метрики для vedarai.ru (27.11).
 *
 * Зачем: владелец устал вручную вставлять токен, а секрет репозитория
 * `YANDEX_WEBMASTER_TOKEN` доступен только раннеру Actions. Этот модуль
 * читает оба хоста Вебмастера и статистику счётчика Метрики и собирает
 * сводку без значения токена и без чужих сайтов аккаунта: журнал прогона
 * и артефакт в публичном репозитории видит кто угодно.
 *
 * Только чтение. Ни один пишущий метод API здесь не вызывается.
 */

import { METRIKA_ID } from '@/lib/analytics/metrika';

export const EXPECTED_USER_ID = 26_262_331;
export const REPORT_HOST_IDS = ['https:vedarai.ru:443', 'http:vedarai.ru:80'] as const;
export const TOKEN_ENV = 'YANDEX_WEBMASTER_TOKEN';
export const WEBMASTER_API = 'https://api.webmaster.yandex.net/v4';
export const METRIKA_STAT_API = 'https://api-metrika.yandex.net/stat/v1/data';
export const METRIKA_GOALS_API = `https://api-metrika.yandex.net/management/v1/counter/${METRIKA_ID}/goals`;
export const SITE_HOST = 'vedarai.ru';

export type Fetcher = (url: string, init: { headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
}>;

export type ApiError = {
  ok: false;
  status: number;
  error_code: string | null;
  error_message: string;
  path: string;
};

export type ApiOk<T> = { ok: true; data: T };
export type ApiResult<T> = ApiOk<T> | ApiError;

export interface QueryRow {
  query: string;
  shows: number | null;
  clicks: number | null;
  show_pos: number | null;
  click_pos: number | null;
}

export interface SitemapRow {
  url: string;
  last_access_date: unknown;
  urls_count: unknown;
  errors_count: unknown;
  sources: unknown;
}

export interface RecrawlTask {
  url: string;
  state: unknown;
  added_time: unknown;
}

export interface HostReport {
  host_id: string;
  info: ApiResult<{
    verified: boolean | null;
    ascii_host_url: unknown;
    host_data_status: unknown;
    main_mirror: unknown;
  }>;
  summary: ApiResult<{
    sqi: unknown;
    searchable_pages_count: unknown;
    excluded_pages_count: unknown;
    site_problems: unknown;
  }>;
  sqi_history: ApiResult<{ points: Array<{ date: unknown; value: unknown }>; latest: unknown }>;
  in_search_history: ApiResult<{ points: Array<{ date: unknown; value: unknown }>; latest: unknown }>;
  sitemaps: ApiResult<{ sitemaps: SitemapRow[] }>;
  recrawl_queue: ApiResult<{ tasks: RecrawlTask[]; by_state: Record<string, number> }>;
  queries: ApiResult<{ date_from: unknown; date_to: unknown; total: unknown; top: QueryRow[] }>;
}

export interface MetrikaTableRow {
  name: string;
  visits: number | null;
  users: number | null;
}

export interface MetrikaWindow {
  key: '7d' | '28d';
  requested: { date1: string; date2: string };
  totals: ApiResult<{ date1: unknown; date2: unknown; visits: number | null; users: number | null }>;
  sources: ApiResult<{ rows: MetrikaTableRow[] }>;
  search_engines: ApiResult<{ rows: MetrikaTableRow[] }>;
  landings: ApiResult<{ rows: MetrikaTableRow[] }>;
  goals: ApiResult<{ rows: Array<{ id: number; name: string; reaches: number | null; users: number | null }> }>;
}

export interface Report {
  generated_at: string;
  today_kamchatka: string;
  token: { found: boolean; name: string | null };
  webmaster: {
    user_id: number | null;
    expected_user_id: number;
    hosts_in_account: number | null;
    our_hosts_found: string[];
    user_error: ApiError | null;
    hosts: HostReport[];
  };
  metrika: {
    counter_id: number;
    windows: MetrikaWindow[];
    goals_list: ApiResult<{ goals: Array<{ id: number; name: string }> }>;
    access_error: ApiError | null;
  };
}

const OUR_HOST_RE = new RegExp(`(^|//|:)(www\\.)?${SITE_HOST.replace('.', '\\.')}(:|/|$)`);

export function redactPath(path: string): string {
  return path.replace(/\/user\/\d+/, '/user/{u}');
}

/** Текст отказа API: код HTTP, код ошибки Яндекса и его сообщение, без тела запроса. */
export function formatApiError(err: Pick<ApiError, 'status' | 'error_code' | 'error_message' | 'path'>): string {
  const code = err.error_code ?? 'нет кода';
  return `HTTP ${err.status} (${code}): ${err.error_message} на ${err.path}`;
}

function asRecord(body: unknown): Record<string, unknown> | null {
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
}

function pickMessage(body: unknown, fallback: string): { error_code: string | null; error_message: string } {
  const rec = asRecord(body);
  if (!rec) return { error_code: null, error_message: fallback };
  const errors = rec.errors;
  const first = Array.isArray(errors) && errors[0] && typeof errors[0] === 'object'
    ? errors[0] as Record<string, unknown>
    : null;
  const fromListType = first && (first.error_type ?? first.error_code);
  const error_code = rec.error_code != null ? String(rec.error_code)
    : rec.error_type != null ? String(rec.error_type)
    : fromListType != null ? String(fromListType)
    : rec.code != null ? String(rec.code)
    : null;
  const fromList = first && (first.message ?? first.error_message ?? first.error_type);
  const error_message = String(rec.error_message ?? rec.message ?? fromList ?? fallback);
  return { error_code, error_message };
}

function historyLatest(points: Array<{ date: unknown; value: unknown }>): unknown {
  if (points.length === 0) return null;
  return points[points.length - 1]?.value ?? null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function queryRows(queries: Array<{ query_text?: string; indicators?: Record<string, number | null> }>, limit: number): QueryRow[] {
  return queries
    .map((q) => ({
      query: q.query_text ?? '',
      shows: q.indicators?.TOTAL_SHOWS ?? null,
      clicks: q.indicators?.TOTAL_CLICKS ?? null,
      show_pos: q.indicators?.AVG_SHOW_POSITION ?? null,
      click_pos: q.indicators?.AVG_CLICK_POSITION ?? null,
    }))
    .sort((a, b) => (b.shows ?? 0) - (a.shows ?? 0))
    .slice(0, limit);
}

export function readToken(env: Record<string, string | undefined>): { name: string; token: string } | { name: null; token: null } {
  const value = (env[TOKEN_ENV] ?? '').trim();
  if (!value) return { name: null, token: null };
  return { name: TOKEN_ENV, token: value };
}

/**
 * Вырезает значение токена из любой строки отчёта. Нужно на случай, если API
 * когда-нибудь вернёт его в сообщении об ошибке: в артефакт оно не попадёт.
 */
export function scrubToken<T>(value: T, token: string | null): T {
  if (!token) return value;
  const raw = JSON.stringify(value);
  if (!raw.includes(token)) return value;
  return JSON.parse(raw.split(token).join('***')) as T;
}


function asApiError(r: ApiResult<unknown>): ApiError {
  if (r.ok) throw new Error('internal: expected API error');
  return r;
}

function keepError<T>(r: ApiResult<unknown>): ApiResult<T> {
  return asApiError(r);
}

async function apiGet(fetcher: Fetcher, token: string, url: string): Promise<ApiResult<unknown>> {
  const path = redactPath(url.replace(WEBMASTER_API, '').replace('https://api-metrika.yandex.net', ''));
  const res = await fetcher(url, {
    headers: { Authorization: `OAuth ${token}`, Accept: 'application/json' },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const { error_code, error_message } = pickMessage(body, res.status === 0 ? 'сеть не ответила' : `ответ ${res.status} без сообщения`);
    return { ok: false, status: res.status, error_code, error_message, path };
  }
  return { ok: true, data: body };
}

function wm(path: string): string {
  return `${WEBMASTER_API}${path}`;
}

function isoWindow(today: string, days: number): { from: string; to: string } {
  const [y, m, d] = today.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d - days));
  return { from: start.toISOString(), to: `${today}T00:00:00.000Z` };
}

const QUERY_INDICATORS = ['TOTAL_SHOWS', 'TOTAL_CLICKS', 'AVG_SHOW_POSITION', 'AVG_CLICK_POSITION']
  .map((i) => `query_indicator=${i}`)
  .join('&');

async function collectHost(fetcher: Fetcher, token: string, userId: number, hostId: string, today: string): Promise<HostReport> {
  const h = `/user/${userId}/hosts/${encodeURIComponent(hostId)}`;
  const week = isoWindow(today, 7);
  const month = isoWindow(today, 28);

  const [info, summary, sqi, inSearch, sitemaps, recrawl, queries] = await Promise.all([
    apiGet(fetcher, token, wm(h)),
    apiGet(fetcher, token, wm(`${h}/summary`)),
    apiGet(fetcher, token, wm(`${h}/sqi-history?date_from=${encodeURIComponent(month.from)}&date_to=${encodeURIComponent(month.to)}`)),
    apiGet(fetcher, token, wm(`${h}/search-urls/in-search/history?date_from=${encodeURIComponent(month.from)}&date_to=${encodeURIComponent(month.to)}`)),
    apiGet(fetcher, token, wm(`${h}/sitemaps?limit=100`)),
    apiGet(fetcher, token, wm(`${h}/recrawl/queue?limit=100&date_from=${encodeURIComponent(week.from)}&date_to=${encodeURIComponent(week.to)}`)),
    apiGet(fetcher, token, wm(`${h}/search-queries/popular?order_by=TOTAL_SHOWS&${QUERY_INDICATORS}&limit=100&date_from=${encodeURIComponent(week.from)}&date_to=${encodeURIComponent(week.to)}`)),
  ]);

  const infoRes: HostReport['info'] = info.ok
    ? {
      ok: true,
      data: {
        verified: typeof (info.data as { verified?: unknown }).verified === 'boolean'
          ? (info.data as { verified: boolean }).verified
          : null,
        ascii_host_url: (info.data as { ascii_host_url?: unknown }).ascii_host_url ?? null,
        host_data_status: (info.data as { host_data_status?: unknown }).host_data_status ?? null,
        main_mirror: sanitizeMirror((info.data as { main_mirror?: unknown }).main_mirror),
      },
    }
    : info;

  const summaryRes: HostReport['summary'] = summary.ok
    ? {
      ok: true,
      data: {
        sqi: (summary.data as { sqi?: unknown }).sqi ?? null,
        searchable_pages_count: (summary.data as { searchable_pages_count?: unknown }).searchable_pages_count ?? null,
        excluded_pages_count: (summary.data as { excluded_pages_count?: unknown }).excluded_pages_count ?? null,
        site_problems: (summary.data as { site_problems?: unknown }).site_problems ?? null,
      },
    }
    : summary;

  const sqiRes: HostReport['sqi_history'] = sqi.ok
    ? (() => {
      const points = ((sqi.data as { points?: Array<{ date: unknown; value: unknown }> }).points ?? []);
      return { ok: true as const, data: { points, latest: historyLatest(points) } };
    })()
    : sqi;

  const inSearchRes: HostReport['in_search_history'] = inSearch.ok
    ? (() => {
      const points = ((inSearch.data as { history?: Array<{ date: unknown; value: unknown }> }).history ?? []);
      return { ok: true as const, data: { points, latest: historyLatest(points) } };
    })()
    : inSearch;

  const sitemapsRes: HostReport['sitemaps'] = sitemaps.ok
    ? {
      ok: true,
      data: {
        sitemaps: ((sitemaps.data as { sitemaps?: Array<Record<string, unknown>> }).sitemaps ?? []).map((s) => ({
          url: String(s.sitemap_url ?? ''),
          last_access_date: s.last_access_date ?? null,
          urls_count: s.urls_count ?? null,
          errors_count: s.errors_count ?? null,
          sources: s.sources ?? null,
        })),
      },
    }
    : sitemaps;

  const recrawlRes: HostReport['recrawl_queue'] = recrawl.ok
    ? (() => {
      const tasks = ((recrawl.data as { tasks?: Array<Record<string, unknown>> }).tasks ?? []).map((t) => ({
        url: String(t.url ?? ''),
        state: t.state ?? null,
        added_time: t.added_time ?? null,
      }));
      const by_state: Record<string, number> = {};
      for (const t of tasks) {
        const key = t.state == null ? 'не назван' : String(t.state);
        by_state[key] = (by_state[key] ?? 0) + 1;
      }
      return { ok: true as const, data: { tasks, by_state } };
    })()
    : recrawl;

  const queriesRes: HostReport['queries'] = queries.ok
    ? {
      ok: true,
      data: {
        date_from: (queries.data as { date_from?: unknown }).date_from ?? null,
        date_to: (queries.data as { date_to?: unknown }).date_to ?? null,
        total: (queries.data as { count?: unknown }).count ?? null,
        top: queryRows((queries.data as { queries?: Array<{ query_text?: string; indicators?: Record<string, number | null> }> }).queries ?? [], 50),
      },
    }
    : queries;

  return {
    host_id: hostId,
    info: infoRes,
    summary: summaryRes,
    sqi_history: sqiRes,
    in_search_history: inSearchRes,
    sitemaps: sitemapsRes,
    recrawl_queue: recrawlRes,
    queries: queriesRes,
  };
}

/** Главное зеркало называем только если это vedarai.ru — чужие сайты в отчёт не идут. */
function sanitizeMirror(mirror: unknown): unknown {
  if (mirror == null) return null;
  const rec = asRecord(mirror);
  if (!rec) return 'задано, формат не разобран';
  const url = String(rec.ascii_host_url ?? rec.host_id ?? '');
  if (OUR_HOST_RE.test(url) || OUR_HOST_RE.test(String(rec.host_id ?? ''))) {
    return { host_id: rec.host_id ?? null, ascii_host_url: rec.ascii_host_url ?? null, verified: rec.verified ?? null };
  }
  return 'задано, не vedarai.ru';
}

function metrikaUrl(params: Record<string, string>): string {
  const q = new URLSearchParams({
    ids: String(METRIKA_ID),
    lang: 'ru',
    accuracy: 'full',
    timezone: '+12:00',
    ...params,
  });
  return `${METRIKA_STAT_API}?${q.toString()}`;
}

function tableRows(body: unknown): MetrikaTableRow[] {
  const data = (asRecord(body)?.data as unknown) ?? [];
  if (!Array.isArray(data)) return [];
  return data.map((row) => {
    const r = asRecord(row) ?? {};
    const dims = Array.isArray(r.dimensions) ? r.dimensions : [];
    const first = asRecord(dims[0]);
    const metrics = Array.isArray(r.metrics) ? r.metrics : [];
    return {
      name: String(first?.name ?? first?.id ?? 'не назван'),
      visits: num(metrics[0]),
      users: num(metrics[1]),
    };
  });
}

function totalsFrom(body: unknown): { date1: unknown; date2: unknown; visits: number | null; users: number | null } {
  const rec = asRecord(body) ?? {};
  const query = asRecord(rec.query) ?? {};
  const totals = Array.isArray(rec.totals) ? rec.totals : [];
  return {
    date1: query.date1 ?? null,
    date2: query.date2 ?? null,
    visits: num(totals[0]),
    users: num(totals[1]),
  };
}

const WINDOWS: Array<{ key: '7d' | '28d'; date1: string; date2: string }> = [
  { key: '7d', date1: '7daysAgo', date2: 'today' },
  { key: '28d', date1: '28daysAgo', date2: 'today' },
];

async function collectMetrikaWindow(
  fetcher: Fetcher,
  token: string,
  win: { key: '7d' | '28d'; date1: string; date2: string },
  goals: Array<{ id: number; name: string }>,
): Promise<MetrikaWindow> {
  const base = { date1: win.date1, date2: win.date2, metrics: 'ym:s:visits,ym:s:users' };
  const [totals, sources, engines, landings, ...goalChunks] = await Promise.all([
    apiGet(fetcher, token, metrikaUrl(base)),
    apiGet(fetcher, token, metrikaUrl({ ...base, dimensions: 'ym:s:lastTrafficSource', limit: '20' })),
    apiGet(fetcher, token, metrikaUrl({
      ...base,
      dimensions: 'ym:s:lastSearchEngine',
      filters: "ym:s:lastTrafficSource=='organic'",
      limit: '20',
    })),
    apiGet(fetcher, token, metrikaUrl({ ...base, dimensions: 'ym:s:startURLPath', limit: '30' })),
    ...chunk(goals, 10).map((part) => {
      const metrics = part.flatMap((g) => [`ym:s:goal${g.id}reaches`, `ym:s:goal${g.id}users`]).join(',');
      return apiGet(fetcher, token, metrikaUrl({ date1: win.date1, date2: win.date2, metrics }));
    }),
  ]);

  let goalsRes: MetrikaWindow['goals'];
  if (goals.length === 0) {
    goalsRes = { ok: true, data: { rows: [] } };
  } else {
    const failed = goalChunks.find((c) => !c.ok);
    if (failed && !failed.ok) goalsRes = keepError(failed);
    else {
      const rows: Array<{ id: number; name: string; reaches: number | null; users: number | null }> = [];
      for (let i = 0; i < goalChunks.length; i++) {
        const chunkRes = goalChunks[i];
        if (!chunkRes.ok) continue;
        const totalsRow = Array.isArray((chunkRes.data as { totals?: unknown[] }).totals)
          ? (chunkRes.data as { totals: unknown[] }).totals
          : [];
        const part = goals.slice(i * 10, i * 10 + 10);
        for (let j = 0; j < part.length; j++) {
          rows.push({
            id: part[j].id,
            name: part[j].name,
            reaches: num(totalsRow[j * 2]),
            users: num(totalsRow[j * 2 + 1]),
          });
        }
      }
      goalsRes = { ok: true, data: { rows } };
    }
  }

  return {
    key: win.key,
    requested: { date1: win.date1, date2: win.date2 },
    totals: totals.ok ? { ok: true, data: totalsFrom(totals.data) } : keepError(totals),
    sources: sources.ok ? { ok: true, data: { rows: tableRows(sources.data) } } : keepError(sources),
    search_engines: engines.ok ? { ok: true, data: { rows: tableRows(engines.data) } } : keepError(engines),
    landings: landings.ok ? { ok: true, data: { rows: tableRows(landings.data) } } : keepError(landings),
    goals: goalsRes,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function collectYandexSeoReport(opts: {
  env: Record<string, string | undefined>;
  fetcher: Fetcher;
  today: string;
  nowIso?: string;
}): Promise<Report> {
  const generated_at = opts.nowIso ?? new Date().toISOString();
  const empty = (extra: Partial<Report> = {}): Report => ({
    generated_at,
    today_kamchatka: opts.today,
    token: { found: false, name: null },
    webmaster: {
      user_id: null,
      expected_user_id: EXPECTED_USER_ID,
      hosts_in_account: null,
      our_hosts_found: [],
      user_error: null,
      hosts: [],
    },
    metrika: { counter_id: METRIKA_ID, windows: [], goals_list: { ok: true, data: { goals: [] } }, access_error: null },
    ...extra,
  });

  const tok = readToken(opts.env);
  if (!tok.token) return empty();

  const user = await apiGet(opts.fetcher, tok.token, wm('/user'));
  if (!user.ok) {
    return empty({
      token: { found: true, name: tok.name },
      webmaster: {
        user_id: null,
        expected_user_id: EXPECTED_USER_ID,
        hosts_in_account: null,
        our_hosts_found: [],
        user_error: user,
        hosts: [],
      },
      metrika: { counter_id: METRIKA_ID, windows: [], goals_list: keepError(user), access_error: user },
    });
  }

  const userId = num((user.data as { user_id?: unknown }).user_id);
  const hostsList = await apiGet(opts.fetcher, tok.token, wm(`/user/${userId}/hosts`));
  let hostsInAccount: number | null = null;
  const ourFound: string[] = [];
  if (hostsList.ok) {
    const hosts = ((hostsList.data as { hosts?: Array<{ host_id?: string; ascii_host_url?: string }> }).hosts ?? []);
    hostsInAccount = hosts.length;
    for (const h of hosts) {
      const id = h.host_id ?? '';
      const url = h.ascii_host_url ?? '';
      if (OUR_HOST_RE.test(id) || OUR_HOST_RE.test(url)) ourFound.push(id);
    }
  }

  const hostReports: HostReport[] = [];
  if (userId != null) {
    for (const hostId of REPORT_HOST_IDS) {
      hostReports.push(await collectHost(opts.fetcher, tok.token, userId, hostId, opts.today));
    }
  }

  const goalsRaw = await apiGet(opts.fetcher, tok.token, METRIKA_GOALS_API);
  let access_error: ApiError | null = null;
  const goalsList: Report['metrika']['goals_list'] = goalsRaw.ok
    ? {
      ok: true,
      data: {
        goals: ((goalsRaw.data as { goals?: Array<{ id?: unknown; name?: unknown }> }).goals ?? [])
          .map((g) => ({ id: num(g.id) ?? 0, name: String(g.name ?? `цель ${g.id}`) }))
          .filter((g) => g.id > 0),
      },
    }
    : keepError(goalsRaw);
  if (!goalsRaw.ok) access_error = asApiError(goalsRaw);

  // Даже без списка целей снимаем визиты и источники: отказ целей не хоронит всю Метрику.
  const windows: MetrikaWindow[] = [];
  const goals = goalsList.ok ? goalsList.data.goals : [];
  for (const win of WINDOWS) {
    const w = await collectMetrikaWindow(opts.fetcher, tok.token, win, goals);
    if (!w.totals.ok && !access_error) access_error = asApiError(w.totals);
    windows.push(w);
  }

  return {
    generated_at,
    today_kamchatka: opts.today,
    token: { found: true, name: tok.name },
    webmaster: {
      user_id: userId,
      expected_user_id: EXPECTED_USER_ID,
      hosts_in_account: hostsInAccount,
      our_hosts_found: ourFound,
      user_error: hostsList.ok ? null : asApiError(hostsList),
      hosts: hostReports,
    },
    metrika: {
      counter_id: METRIKA_ID,
      windows,
      goals_list: goalsList,
      access_error,
    },
  };
}

const fmt = (v: unknown) => (v == null || v === '' ? '—' : String(v));
const fmtNum = (v: number | null | undefined) => (v == null ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(1));

function sectionResult<T>(r: ApiResult<T>, ok: (data: T) => string[]): string[] {
  if (!r.ok) return [`**Не прочиталось** — ${formatApiError(r)}`];
  return ok(r.data);
}

export function renderReportMarkdown(report: Report): string {
  const out: string[] = [];
  out.push('# Еженедельный отчёт Яндекс Вебмастера и Метрики');
  out.push('');
  out.push(`Снято **${report.generated_at}** (UTC); календарный день на Камчатке: **${report.today_kamchatka}**. Только чтение. Токен в этот файл не записывался.`);
  out.push('');

  if (!report.token.found) {
    out.push(`Токен: **не найден**. В секретах репозитория нет непустого \`${TOKEN_ENV}\`.`);
    return out.join('\n') + '\n';
  }
  out.push(`Токен: принят секрет \`${report.token.name}\`.`);
  out.push('');

  out.push('## Вебмастер');
  out.push('');
  if (report.webmaster.user_error && report.webmaster.user_id == null) {
    out.push(`API пользователя: **не прочитался** — ${formatApiError(report.webmaster.user_error)}.`);
    out.push('');
  } else {
    const same = report.webmaster.user_id === report.webmaster.expected_user_id;
    out.push(`user_id: ${fmt(report.webmaster.user_id)}${same ? ' (совпал с ожидаемым 26262331)' : ` (ожидали 26262331)`}.`);
    out.push(`Сайтов в аккаунте: ${fmt(report.webmaster.hosts_in_account)}; наших среди них: ${report.webmaster.our_hosts_found.length ? report.webmaster.our_hosts_found.map((h) => `\`${h}\``).join(', ') : 'нет'}.`);
    if (report.webmaster.user_error) out.push(`Список хостов: **не прочитался** — ${formatApiError(report.webmaster.user_error)}.`);
    out.push('');
  }

  for (const host of report.webmaster.hosts) {
    out.push(`### \`${host.host_id}\``);
    out.push('');
    out.push('**Карточка хоста**');
    out.push(...sectionResult(host.info, (d) => [
      `- статус загрузки: \`${fmt(d.host_data_status)}\``,
      `- адрес: ${fmt(d.ascii_host_url)}`,
      `- права: ${d.verified === true ? 'подтверждены' : d.verified === false ? '**не подтверждены**' : 'не названы'}`,
      `- главное зеркало: ${d.main_mirror == null ? 'не задано' : `\`${JSON.stringify(d.main_mirror)}\``}`,
    ]));
    out.push('');
    out.push('**Сводка (ИКС и страницы в поиске)**');
    out.push(...sectionResult(host.summary, (d) => [
      `- ИКС: ${fmt(d.sqi)}`,
      `- страниц в поиске: ${fmt(d.searchable_pages_count)}`,
      `- исключено: ${fmt(d.excluded_pages_count)}`,
      `- проблемы сайта: \`${JSON.stringify(d.site_problems)}\``,
    ]));
    out.push('');
    out.push('**История ИКС (28 дней)**');
    out.push(...sectionResult(host.sqi_history, (d) => [
      d.points.length === 0 ? 'Точек нет.' : `- последняя точка: ${fmt(d.latest)}; точек в окне: ${d.points.length}`,
    ]));
    out.push('');
    out.push('**История страниц в поиске (28 дней)**');
    out.push(...sectionResult(host.in_search_history, (d) => [
      d.points.length === 0 ? 'Точек нет.' : `- последняя точка: ${fmt(d.latest)}; точек в окне: ${d.points.length}`,
    ]));
    out.push('');
    out.push('**Карты сайта**');
    out.push(...sectionResult(host.sitemaps, (d) => {
      if (d.sitemaps.length === 0) return ['Файлов нет.'];
      const lines = [`Файлов: ${d.sitemaps.length}.`, '', '| URL | URL в файле | Ошибки | Последний доступ |', '|---|---:|---:|---|'];
      for (const s of d.sitemaps) lines.push(`| ${s.url || '—'} | ${fmt(s.urls_count)} | ${fmt(s.errors_count)} | ${fmt(s.last_access_date)} |`);
      return lines;
    }));
    out.push('');
    out.push('**Очередь переобхода (7 дней)**');
    out.push(...sectionResult(host.recrawl_queue, (d) => {
      const states = Object.entries(d.by_state).map(([k, v]) => `${k}: ${v}`).join(', ') || 'пусто';
      const lines = [`Задач в выборке: ${d.tasks.length} (${states}).`];
      for (const t of d.tasks.slice(0, 20)) lines.push(`- ${t.state ?? '—'} ${t.url} (${fmt(t.added_time)})`);
      if (d.tasks.length > 20) lines.push(`- … ещё ${d.tasks.length - 20}`);
      return lines;
    }));
    out.push('');
    out.push('**Популярные запросы (7 дней)**');
    out.push(...sectionResult(host.queries, (d) => {
      const lines = [`Окно API: ${fmt(d.date_from)} — ${fmt(d.date_to)}; запросов всего: ${fmt(d.total)}.`];
      if (d.top.length === 0) lines.push('Запросов с показами нет.');
      else {
        lines.push('', '| Запрос | Показы | Клики | Позиция показа | Позиция клика |', '|---|---:|---:|---:|---:|');
        for (const row of d.top.slice(0, 20)) {
          lines.push(`| ${row.query.replace(/\|/g, '/')} | ${fmtNum(row.shows)} | ${fmtNum(row.clicks)} | ${fmtNum(row.show_pos)} | ${fmtNum(row.click_pos)} |`);
        }
      }
      return lines;
    }));
    out.push('');
  }

  out.push('## Метрика');
  out.push('');
  out.push(`Счётчик \`${report.metrika.counter_id}\`.`);
  if (report.metrika.access_error) {
    out.push(`Отказ доступа или чтения: **${formatApiError(report.metrika.access_error)}**.`);
    out.push('');
  }
  out.push('**Список целей**');
  out.push(...sectionResult(report.metrika.goals_list, (d) => (
    d.goals.length === 0 ? ['Целей нет или список пуст.'] : d.goals.map((g) => `- ${g.id}: ${g.name}`)
  )));
  out.push('');

  for (const w of report.metrika.windows) {
    const title = w.key === '7d' ? '7 дней' : '28 дней';
    out.push(`### ${title} (\`${w.requested.date1}\` — \`${w.requested.date2}\`)`);
    out.push('');
    out.push('**Визиты и посетители**');
    out.push(...sectionResult(w.totals, (d) => [
      `- фактическое окно API: ${fmt(d.date1)} — ${fmt(d.date2)}`,
      `- визиты: ${fmtNum(d.visits)}`,
      `- посетители: ${fmtNum(d.users)}`,
    ]));
    out.push('');
    out.push('**Источники**');
    out.push(...sectionResult(w.sources, (d) => tableMd(d.rows)));
    out.push('');
    out.push('**Поисковые системы (organic)**');
    out.push(...sectionResult(w.search_engines, (d) => tableMd(d.rows)));
    out.push('');
    out.push('**Посадочные страницы**');
    out.push(...sectionResult(w.landings, (d) => tableMd(d.rows)));
    out.push('');
    out.push('**Цели**');
    out.push(...sectionResult(w.goals, (d) => {
      if (d.rows.length === 0) return ['Нет данных по целям.'];
      const lines = ['| Цель | Достижения | Пользователи |', '|---|---:|---:|'];
      for (const g of d.rows) lines.push(`| ${g.id}: ${g.name.replace(/\|/g, '/')} | ${fmtNum(g.reaches)} | ${fmtNum(g.users)} |`);
      return lines;
    }));
    out.push('');
  }

  return out.join('\n') + '\n';
}

function tableMd(rows: MetrikaTableRow[]): string[] {
  if (rows.length === 0) return ['Строк нет.'];
  const lines = ['| Название | Визиты | Посетители |', '|---|---:|---:|'];
  for (const r of rows) lines.push(`| ${r.name.replace(/\|/g, '/')} | ${fmtNum(r.visits)} | ${fmtNum(r.users)} |`);
  return lines;
}

/** Исход прогона: красный только когда токена нет или API пользователя его не принял. */
export function reportOutcome(report: Report): { level: 'ok' | 'warning' | 'error'; message: string } {
  if (!report.token.found) return { level: 'error', message: `секрет ${TOKEN_ENV} не задан в Actions secrets` };
  if (report.webmaster.user_id == null) {
    const err = report.webmaster.user_error ? formatApiError(report.webmaster.user_error) : 'API /user не вернул user_id';
    return { level: 'error', message: err };
  }
  const bits: string[] = [];
  for (const host of report.webmaster.hosts) {
    const failed = [host.info, host.summary, host.sqi_history, host.in_search_history, host.sitemaps, host.recrawl_queue, host.queries]
      .filter((s) => !s.ok).length;
    if (failed > 0) bits.push(`${host.host_id}: не прочитались ${failed} разделов`);
  }
  if (report.metrika.access_error) bits.push(`Метрика: ${formatApiError(report.metrika.access_error)}`);
  else {
    for (const w of report.metrika.windows) {
      const failed = [w.totals, w.sources, w.search_engines, w.landings, w.goals].filter((s) => !s.ok).length;
      if (failed > 0) bits.push(`Метрика ${w.key}: не прочитались ${failed} разделов`);
    }
  }
  if (bits.length > 0) return { level: 'warning', message: bits.join('; ') };
  return { level: 'ok', message: 'все разделы прочитаны' };
}
