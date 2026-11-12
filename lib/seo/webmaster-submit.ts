/**
 * Загрузка в Яндекс Вебмастер (11.11, владелец: «поработай с вебмастером,
 * загрузи им наши файлы»): карта сайта и просьба переобойти главные
 * страницы — для https://vedarai.ru/, добавленного и подтверждённого 11.11.
 *
 * Перепись (lib/seo/webmaster-census) только читает; здесь — два пишущих
 * метода API v4, и только они:
 *   - POST /user/{u}/hosts/{h}/user-added-sitemaps — добавить карту сайта;
 *     уже добавленная не шлётся повторно (сверка с GET того же адреса);
 *   - POST /user/{u}/hosts/{h}/recrawl/queue — страница в очередь переобхода;
 *     сначала GET …/recrawl/quota, сверх остатка квоты не шлём.
 *
 * Шлются только адреса нашего сайта (https://vedarai.ru/…): маркер — файл в
 * репозитории, и чужой адрес из него в Вебмастер не уйдёт. Токен — один
 * секрет YANDEX_WEBMASTER_TOKEN (имя установлено переписью 11.11); значение
 * никуда не печатается. Хост — тем же правилом, что у переписи (pickOurHost:
 * https с правами первым).
 *
 * Три исхода у каждого адреса (§4.0): сделано, уже было / не хватило квоты,
 * не вышло — с кодом ответа и кодом ошибки Яндекса.
 */
import { pickOurHost, SITE_HOST, WEBMASTER_API, type ApiHost } from '@/lib/seo/webmaster-census';

export type WriteFetcher = (url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean; status: number; json: () => Promise<unknown>;
}>;

/** Только адреса нашего сайта по https. */
export const OUR_ORIGIN = `https://${SITE_HOST}`;
export function isOurUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const u = new URL(url);
  return u.origin === OUR_ORIGIN && !u.username && !u.password;
}

async function api(fetcher: WriteFetcher, token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  const res = await fetcher(`${WEBMASTER_API}${path}`, {
    method,
    headers: {
      Authorization: `OAuth ${token}`,
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const code = json && typeof json === 'object' && 'error_code' in json
      ? String((json as { error_code: unknown }).error_code) : 'нет кода';
    throw new Error(`HTTP ${res.status} (${code}) на ${method} ${path.replace(/\/user\/\d+/, '/user/{u}')}`);
  }
  return json;
}

/**
 * Повтор при сбое шлюза Яндекса (502/503/504). Прогон 1 (11.11, Actions
 * 43007784634): все десять пишущих запросов получили 504 без кода ошибки, при
 * том что чтения того же хоста прошли. Это отказ шлюза, а не ответ API, и один
 * такой не решает судьбу прогона: до двух повторов с паузой. Ответ с кодом
 * ошибки Яндекса не повторяется: там Яндекс сказал, что не так. Пишущий запрос
 * после 504 мог и пройти; повторная карта сайта отвечает своим кодом, и он
 * будет назван, а не спрятан.
 */
export const GATEWAY_RETRY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);
export const GATEWAY_RETRY_PAUSES_MS: readonly number[] = [5_000, 10_000];

export function withGatewayRetry<I, R extends { status: number }>(
  fetcher: (url: string, init: I) => Promise<R>,
  pause: (ms: number) => Promise<void>,
): (url: string, init: I) => Promise<R> {
  return async (url, init) => {
    let res = await fetcher(url, init);
    for (const ms of GATEWAY_RETRY_PAUSES_MS) {
      if (!GATEWAY_RETRY_STATUSES.has(res.status)) return res;
      await pause(ms);
      res = await fetcher(url, init);
    }
    return res;
  };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type ItemOutcome =
  | { url: string; outcome: 'done' }
  | { url: string; outcome: 'already' }
  | { url: string; outcome: 'no_quota' }
  | { url: string; outcome: 'failed'; detail: string };

export interface SubmitResult {
  /** null — токена нет; строка — токен не принят (причина). */
  token: 'ok' | null | string;
  host: { url: string; verified: boolean | null } | null | { error: string };
  sitemaps: ItemOutcome[];
  quota: { daily: number | null; remainder: number | null } | { error: string } | null;
  recrawl: ItemOutcome[];
  /** Адреса маркера, отброшенные как не наши. */
  rejected: string[];
  /** Список уже добавленных карт не прочитался — причина (добавление всё равно пробуется). */
  sitemaps_list_error?: string;
}

export async function webmasterSubmit(opts: {
  token: string | undefined;
  fetcher: WriteFetcher;
  sitemaps: readonly string[];
  recrawl: readonly string[];
  /** Пауза перед повтором при сбое шлюза; в тестах — без ожидания. */
  pause?: (ms: number) => Promise<void>;
}): Promise<SubmitResult> {
  const fetcher = withGatewayRetry(opts.fetcher, opts.pause ?? sleep);
  const rejected = [...opts.sitemaps, ...opts.recrawl].filter((u) => !isOurUrl(u));
  const sitemaps = [...new Set(opts.sitemaps.filter(isOurUrl))];
  const recrawl = [...new Set(opts.recrawl.filter(isOurUrl))];
  const result: SubmitResult = { token: null, host: null, sitemaps: [], quota: null, recrawl: [], rejected };

  const token = opts.token?.trim();
  if (!token) return result;

  let userId: number;
  try {
    const me = await api(fetcher, token, 'GET', '/user') as { user_id?: unknown };
    if (typeof me?.user_id !== 'number') { result.token = 'ответ без user_id'; return result; }
    userId = me.user_id;
    result.token = 'ok';
  } catch (e) {
    result.token = errText(e);
    return result;
  }

  const u = `/user/${userId}`;
  let hostId: string;
  try {
    const body = await api(fetcher, token, 'GET', `${u}/hosts`) as { hosts?: ApiHost[] };
    const ours = (body.hosts ?? []).filter((h) => new RegExp(`(^|//|:)(www\\.)?${SITE_HOST.replace('.', '\\.')}(:|/|$)`).test(h.ascii_host_url));
    const site = pickOurHost(ours);
    if (!site) { result.host = null; return result; }
    result.host = { url: site.ascii_host_url, verified: typeof site.verified === 'boolean' ? site.verified : null };
    hostId = site.host_id;
  } catch (e) {
    result.host = { error: errText(e) };
    return result;
  }
  const h = `${u}/hosts/${encodeURIComponent(hostId)}`;

  // Карты сайта: уже добавленные не шлём повторно.
  let have: Set<string> | null = null;
  try {
    const list = await api(fetcher, token, 'GET', `${h}/user-added-sitemaps`) as { sitemaps?: Array<{ sitemap_url?: string }> };
    have = new Set((list.sitemaps ?? []).map((s) => s.sitemap_url ?? '').filter(Boolean));
  } catch (e) {
    // Список не прочитался — добавить всё равно пробуем: повтор Вебмастер
    // отклонит своим кодом, и он будет назван. Причина — в сводку, не в тишину.
    have = null;
    result.sitemaps_list_error = errText(e);
  }
  for (const url of sitemaps) {
    if (have?.has(url)) { result.sitemaps.push({ url, outcome: 'already' }); continue; }
    try {
      await api(fetcher, token, 'POST', `${h}/user-added-sitemaps`, { url });
      result.sitemaps.push({ url, outcome: 'done' });
    } catch (e) {
      result.sitemaps.push({ url, outcome: 'failed', detail: errText(e) });
    }
  }

  // Переобход: сверх остатка квоты не шлём.
  let remainder = Number.POSITIVE_INFINITY;
  if (recrawl.length > 0) {
    try {
      const q = await api(fetcher, token, 'GET', `${h}/recrawl/quota`) as { daily_quota?: unknown; quota_remainder?: unknown };
      const num = (v: unknown) => (typeof v === 'number' ? v : null);
      result.quota = { daily: num(q.daily_quota), remainder: num(q.quota_remainder) };
      if (result.quota.remainder !== null) remainder = result.quota.remainder;
    } catch (e) {
      result.quota = { error: errText(e) };
    }
  }
  for (const url of recrawl) {
    if (remainder <= 0) { result.recrawl.push({ url, outcome: 'no_quota' }); continue; }
    try {
      await api(fetcher, token, 'POST', `${h}/recrawl/queue`, { url });
      result.recrawl.push({ url, outcome: 'done' });
      remainder -= 1;
    } catch (e) {
      result.recrawl.push({ url, outcome: 'failed', detail: errText(e) });
    }
  }
  return result;
}

const WORD: Record<ItemOutcome['outcome'], string> = {
  done: 'отправлено',
  already: 'уже было',
  no_quota: 'не отправлено — кончилась дневная квота',
  failed: 'не вышло',
};

/** Сводка в журнал: без значения токена. */
export function submitDigest(r: SubmitResult): string[] {
  const lines = ['## Загрузка в Яндекс Вебмастер', ''];
  if (r.token === null) return [...lines, 'Токена нет: секрет YANDEX_WEBMASTER_TOKEN пуст.'];
  if (r.token !== 'ok') return [...lines, `Токен не принят: ${r.token}.`];
  if (r.host === null) return [...lines, `Сайта ${SITE_HOST} в аккаунте Вебмастера нет.`];
  if ('error' in r.host) return [...lines, `Список сайтов не прочитался: ${r.host.error}.`];
  lines.push(`Сайт: ${r.host.url}${r.host.verified === false ? ' (права НЕ подтверждены)' : ''}.`, '');
  const item = (i: ItemOutcome) => `- ${i.url} — ${WORD[i.outcome]}${i.outcome === 'failed' ? `: ${i.detail}` : ''}`;
  lines.push('### Карта сайта', ...(r.sitemaps.length ? r.sitemaps.map(item) : ['- в маркере нет']));
  if (r.sitemaps_list_error) lines.push(`Список уже добавленных карт не прочитался: ${r.sitemaps_list_error}.`);
  lines.push('');
  if (r.quota && 'error' in r.quota) lines.push(`Квота переобхода не прочиталась: ${r.quota.error}.`);
  else if (r.quota) lines.push(`Квота переобхода: остаток ${r.quota.remainder ?? 'не назван'} из ${r.quota.daily ?? 'не названо'} в день.`);
  lines.push('### Переобход', ...(r.recrawl.length ? r.recrawl.map(item) : ['- в маркере нет']));
  if (r.rejected.length) lines.push('', `Не наши адреса не отправлялись: ${r.rejected.join(', ')}.`);
  return lines;
}

/** Исход прогона: ошибка — ничего не сделано; предупреждение — часть не вышла. */
export function submitOutcome(r: SubmitResult): { level: 'ok' | 'warning' | 'error'; message: string } {
  if (r.token !== 'ok') return { level: 'error', message: r.token === null ? 'токена нет' : `токен не принят: ${r.token}` };
  if (r.host === null || 'error' in r.host) return { level: 'error', message: 'сайт не найден или список не прочитался' };
  const all = [...r.sitemaps, ...r.recrawl];
  if (all.length === 0) return { level: 'error', message: 'в маркере нет ни одного нашего адреса' };
  const failed = all.filter((i) => i.outcome === 'failed').length;
  const moved = all.filter((i) => i.outcome === 'done' || i.outcome === 'already').length;
  if (moved === 0) return { level: 'error', message: `ни один адрес не принят (${failed} отказов)` };
  if (failed > 0 || all.some((i) => i.outcome === 'no_quota')) return { level: 'warning', message: `часть адресов не принята: ${failed} отказов` };
  return { level: 'ok', message: 'всё принято' };
}
