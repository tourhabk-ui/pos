/**
 * Расшифровка журнала MCP по суткам: кто звал и чем интересовался (слово
 * владельца 22.10: «нужна расшифровка по дням mcp кто звал чем интересовался
 * при нажатии на информационные кнопки с числами»).
 *
 * Кто — имя программы из её самопредставления при рукопожатии
 * (`mcp_clients.client_name`), род по заголовку на подхвате, иначе «не
 * представился». Это имя программы, не человека: личность вызывающего —
 * суточный хэш, и наружу он не отдаётся, только число разных за сутки.
 *
 * Чем интересовался — инструмент и главный аргумент вызова, который журнал
 * пишет сам (lib/mcp/call-reason): имя аргумента у всех, значение — только у
 * читающих инструментов, не длиннее 40 знаков, с цифрами телефона и почтой
 * «[скрыто]». Остального журнал не знает, и расшифровка не делает вид, что
 * знает.
 *
 * Род вызова — тот же, что у чисел страницы: внешний (без метки владельца и
 * без проверок lib/mcp/probe-clients), свой, проверка. Сутки камчатские.
 */
import { pool } from '@/lib/db-pool';
import { PROBE_PARAMS, probeCallSql } from '@/lib/mcp/probe-clients';
import { REFUSAL_KINDS } from '@/lib/mcp/call-log';
import { clientRegion } from '@/lib/mcp/china-clients';
import { kamchatkaDate, kamchatkaDayStart, shiftDate } from '@/lib/analytics/kamchatka-day';

export {
  BREAKDOWN_ORIGINS, BREAKDOWN_OUTCOMES,
  type BreakdownOrigin, type BreakdownOutcome, type BreakdownQuery, type TopicRow, type ClientDay, type BreakdownDay, type Breakdown,
} from '@/lib/mcp/day-breakdown-types';
import type { BreakdownOrigin, BreakdownOutcome, BreakdownQuery, ClientDay, BreakdownDay, Breakdown, TopicRow } from '@/lib/mcp/day-breakdown-types';

/** Сколько тем показывать у программы за сутки: дальше — хвост числом. */
export const TOPICS_PER_CLIENT = 12;

export function breakdownRange(q: Pick<BreakdownQuery, 'days' | 'skip'>, now: Date): { from: string; to: string; start: Date; end: Date } {
  const to = shiftDate(kamchatkaDate(now), -q.skip);
  const from = shiftDate(to, -(q.days - 1));
  return { from, to, start: kamchatkaDayStart(from), end: kamchatkaDayStart(shiftDate(to, 1)) };
}

const ORIGIN_SQL: Record<BreakdownOrigin, string> = {
  external: 'NOT is_self AND NOT is_probe',
  self: 'is_self',
  probe: 'NOT is_self AND is_probe',
  own: '(is_self OR is_probe)',
};
/**
 * Отказ — инструмент ответил агенту (REFUSAL_KINDS), сбой — упал; строка без
 * рода — сбой, как на странице. Признак считается в общем подзапросе: так $4
 * используется при любом исходе, и сервер выводит его тип (иначе при «все»
 * PostgreSQL отвечает «could not determine data type of parameter $4»).
 */
const OUTCOME_SQL: Record<BreakdownOutcome, string> = {
  all: 'TRUE',
  failure: 'NOT ok AND NOT is_refusal',
  refusal: 'NOT ok AND is_refusal',
};

interface DetailRow {
  day: string; client: string; kind: string; origin: 'external' | 'self' | 'probe';
  tool: string; arg_key: string | null; arg_value: string | null;
  calls: number; failures: number; refusals: number;
}
interface CallerRow { day: string; client: string | null; kind: string | null; origin: string | null; callers: number }

/** Свести строки запроса в сутки → программы → инструменты и темы. Чистая функция. */
export function foldBreakdown(rows: DetailRow[], callerRows: CallerRow[]): BreakdownDay[] {
  const days = new Map<string, BreakdownDay>();
  const clientKey = (r: { client: string | null; kind: string | null; origin: string | null }) => `${r.client}\u0000${r.kind}\u0000${r.origin}`;
  const clients = new Map<string, Map<string, ClientDay & { topicMap: Map<string, TopicRow>; toolMap: Map<string, number> }>>();
  for (const r of rows) {
    const day = days.get(r.day) ?? { day: r.day, calls: 0, callers: 0, clients: [] };
    days.set(r.day, day);
    day.calls += r.calls;
    const byClient = clients.get(r.day) ?? new Map();
    clients.set(r.day, byClient);
    const k = clientKey(r);
    const c = byClient.get(k) ?? {
      client: r.client, kind: r.kind, origin: r.origin, region: clientRegion(r.client),
      calls: 0, callers: 0, failures: 0, refusals: 0, tools: [], topics: [], topics_more: 0,
      topicMap: new Map<string, TopicRow>(), toolMap: new Map<string, number>(),
    };
    byClient.set(k, c);
    c.calls += r.calls; c.failures += r.failures; c.refusals += r.refusals;
    c.toolMap.set(r.tool, (c.toolMap.get(r.tool) ?? 0) + r.calls);
    const tk = `${r.tool}\u0000${r.arg_key ?? ''}\u0000${r.arg_value ?? ''}`;
    const t = c.topicMap.get(tk) ?? { tool: r.tool, key: r.arg_key, value: r.arg_value, n: 0 };
    t.n += r.calls;
    c.topicMap.set(tk, t);
  }
  for (const cr of callerRows) {
    const day = days.get(cr.day);
    if (!day) continue;
    if (cr.client === null) { day.callers = cr.callers; continue; }
    const c = clients.get(cr.day)?.get(clientKey(cr));
    if (c) c.callers = cr.callers;
  }
  for (const [d, byClient] of clients) {
    const day = days.get(d)!;
    day.clients = [...byClient.values()]
      .map(({ topicMap, toolMap, ...c }) => ({
        ...c,
        tools: [...toolMap.entries()].map(([tool, calls]) => ({ tool, calls })).sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)),
        topics: [...topicMap.values()].sort((a, b) => b.n - a.n || a.tool.localeCompare(b.tool)),
      }))
      .sort((a, b) => b.calls - a.calls || a.client.localeCompare(b.client));
  }
  return [...days.values()].sort((a, b) => b.day.localeCompare(a.day));
}

export async function readMcpBreakdown(q: BreakdownQuery, now: Date = new Date()): Promise<Breakdown> {
  const range = breakdownRange(q, now);
  const params = [...PROBE_PARAMS, [...REFUSAL_KINDS], range.start, range.end];
  // Соединение с mcp_clients — по суточному ключу журнала, тому же, которым
  // probeCallSql решает «проверка»: так программа и род вызова считаются по
  // одной строке, а не по двум разным правилам.
  const calls = `
    WITH calls AS (
      SELECT (t.created_at AT TIME ZONE 'Asia/Kamchatka')::date AS day,
             t.tool, t.ok, t.error_kind, t.arg_key, t.arg_value, t.caller_hash, t.is_self,
             ${probeCallSql('t', '$1', '$2', '$3')} AS is_probe,
             COALESCE(t.error_kind = ANY($4::text[]), FALSE) AS is_refusal,
             COALESCE(c.client_name, c.ua_family, 'не представился') AS client,
             CASE WHEN c.client_name IS NOT NULL THEN 'представился'
                  WHEN c.ua_family  IS NOT NULL THEN 'по заголовку'
                  ELSE 'неизвестно' END AS kind
        FROM mcp_tool_calls t
        LEFT JOIN mcp_clients c ON c.caller_hash = t.caller_hash AND c.day = t.created_at::date
       WHERE t.created_at >= $5::timestamptz AND t.created_at < $6::timestamptz
    ), picked AS (
      SELECT *, CASE WHEN is_self THEN 'self' WHEN is_probe THEN 'probe' ELSE 'external' END AS origin
        FROM calls
       WHERE ${ORIGIN_SQL[q.origin]} AND ${OUTCOME_SQL[q.outcome]}
    )`;
  const [detail, callers] = await Promise.all([
    pool.query<DetailRow>(
      `${calls}
       SELECT to_char(day, 'YYYY-MM-DD') AS day, client, kind, origin, tool, arg_key, arg_value,
              COUNT(*)::int AS calls,
              COUNT(*) FILTER (WHERE NOT ok AND NOT is_refusal)::int AS failures,
              COUNT(*) FILTER (WHERE NOT ok AND is_refusal)::int AS refusals
         FROM picked
        GROUP BY day, client, kind, origin, tool, arg_key, arg_value`,
      params,
    ),
    // Разных вызывающих — и по программе, и за сутки целиком: сумма по
    // программам не равна числу за сутки, если одна программа звала из двух мест.
    pool.query<CallerRow>(
      `${calls}
       SELECT to_char(day, 'YYYY-MM-DD') AS day, client, kind, origin, COUNT(DISTINCT caller_hash)::int AS callers
         FROM picked
        GROUP BY GROUPING SETS ((day, client, kind, origin), (day))`,
      params,
    ),
  ]);
  const days = foldBreakdown(detail.rows, callers.rows).map((d) => ({
    ...d,
    clients: d.clients.map((c) => ({
      ...c,
      topics: c.topics.slice(0, TOPICS_PER_CLIENT),
      topics_more: Math.max(0, c.topics.length - TOPICS_PER_CLIENT),
    })),
  }));
  return { from: range.from, to: range.to, days };
}
