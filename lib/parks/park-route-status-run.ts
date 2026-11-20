/**
 * Прогон чтения статусов со страницы парка (GET /api/cron/park-route-status).
 * Правила разбора — lib/parks/park-route-status; здесь сеть и запись.
 *
 * Исходы (§4.0):
 *   — `fetch_failed`: страница не ответила — ничего не пишется, прежние
 *     статусы стареют и через трое суток читаются «не проверено»;
 *   — `parse_empty`: страница ответила, а строк статуса нет — разметка
 *     изменилась; это отказ, а не «маршрутов нет»;
 *   — `read`: записаны совпавшие варианты; строки страницы, которых нет в
 *     справочнике (`not_in_table`), и варианты справочника, которых не было на
 *     странице (`not_on_page`), названы в ответе — их статус не тронут.
 */
import { pool } from '@/lib/db-pool';
import { APPROVED_ROUTES_SOURCE } from '@/lib/parks/approved-routes-words';
import { parseParkRoutesPage, type ParsedStatusRow } from '@/lib/parks/park-route-status';

export type QueryFn = <T>(sql: string, params: unknown[]) => Promise<{ rows: T[] }>;

export type ParkStatusRun =
  | { outcome: 'fetch_failed'; error: string }
  | { outcome: 'parse_empty'; problems: string[] }
  | {
      outcome: 'read';
      parsed: number;
      written: number;
      open: string[];
      not_in_table: string[];
      not_on_page: string[];
      problems: string[];
    };

/** Запись статусов одним запросом: только варианты справочника, совпавшие точно. */
export const WRITE_STATUS_SQL = `
  UPDATE park_approved_routes a
     SET status = v.status, status_read_at = NOW()
    FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS v(park_slug, title, season, status)
   WHERE a.park_slug = v.park_slug AND a.title = v.title AND a.season = v.season
  RETURNING a.park_slug, a.title, a.season`;

export const ALL_VARIANTS_SQL = `SELECT park_slug, title, season FROM park_approved_routes ORDER BY park_slug, title, season`;

const key = (r: { park_slug?: string; parkSlug?: string; title: string; season: string }) =>
  `${r.park_slug ?? r.parkSlug} · ${r.title} · ${r.season}`;

const FETCH_TIMEOUT_MS = 30_000;
const MAX_BYTES = 2_000_000;

async function fetchPage(url: string): Promise<{ html: string } | { error: string }> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'VedarBot/1.0 (+https://vedarai.ru)', Accept: 'text/html' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const html = await res.text();
    if (html.length > MAX_BYTES) return { error: `страница больше ${MAX_BYTES} знаков` };
    return { html };
  } catch (err) {
    return { error: err instanceof Error ? err.name === 'TimeoutError' ? `нет ответа за ${FETCH_TIMEOUT_MS / 1000} с` : err.message.slice(0, 160) : 'отказ сети' };
  }
}

export async function runParkStatusRead(deps: {
  query?: QueryFn;
  fetchHtml?: (url: string) => Promise<{ html: string } | { error: string }>;
} = {}): Promise<ParkStatusRun> {
  const q: QueryFn = deps.query ?? ((sql, params) => pool.query(sql, params) as never);
  const page = await (deps.fetchHtml ?? fetchPage)(APPROVED_ROUTES_SOURCE);
  if ('error' in page) return { outcome: 'fetch_failed', error: page.error };

  const { rows, problems } = parseParkRoutesPage(page.html);
  if (rows.length === 0) return { outcome: 'parse_empty', problems };

  // Повтор одного варианта на странице — второй не пишется молча поверх первого.
  const seen = new Map<string, ParsedStatusRow>();
  for (const r of rows) {
    const k = key(r);
    if (seen.has(k)) problems.push(`вариант на странице дважды: ${k}`);
    else seen.set(k, r);
  }
  const uniq = [...seen.values()];
  const written = (await q<{ park_slug: string; title: string; season: string }>(WRITE_STATUS_SQL, [
    uniq.map((r) => r.parkSlug), uniq.map((r) => r.title), uniq.map((r) => r.season), uniq.map((r) => r.status),
  ])).rows;
  const writtenKeys = new Set(written.map(key));
  const all = (await q<{ park_slug: string; title: string; season: string }>(ALL_VARIANTS_SQL, [])).rows;

  return {
    outcome: 'read',
    parsed: uniq.length,
    written: written.length,
    open: uniq.filter((r) => r.status === 'open' && writtenKeys.has(key(r))).map(key),
    not_in_table: uniq.filter((r) => !writtenKeys.has(key(r))).map(key),
    not_on_page: all.filter((r) => !writtenKeys.has(key(r))).map(key),
    problems,
  };
}
