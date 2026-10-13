/**
 * GET /api/admin/analytics/a2a — кто приходит из ИИ: три двери одним срезом
 * (решение владельца 12.10: «я бы хотел видеть в админ-хабе A2A, хотя бы кто
 * заходит из ИИ»).
 *
 *  1. A2A — журнал a2a_requests (lib/a2a/journal, миграция 1219): кто
 *     (самоназвание программы), сколько, диалоги, текст / инструмент, исходы,
 *     версии протокола, последние запросы.
 *  2. MCP — mcp_clients (872): кто подключался, представившись при
 *     рукопожатии или по роду заголовка; подробный срез вызовов — /hub/admin/mcp.
 *  3. Визитки и манифесты — agent_entry_hits (1218): какие семейства
 *     обходчиков читают robots, llms.txt, манифесты, визитки и OpenAPI.
 *
 *  4. Журнал общения — a2a_dialogs (lib/a2a/dialog-log, миграция 1225; решение
 *     владельца 13.10): что агенты спросили у Кузьмича и что он ответил.
 *     Последние DIALOG_LIMIT реплик без привязки к окну; текст — после
 *     redactPII и не старше RETENTION_DAYS.
 *
 * Три исхода у КАЖДОГО блока отдельно (§4.0): данные; «за окно пусто» с датой,
 * с которой журнал ведётся (ноль только что заведённой таблицы — не «никто не
 * ходит»); «не прочиталось» — блок ok:false с SQLSTATE в логе, остальные
 * блоки живут. Сырых User-Agent и IP нет ни в одном источнике; текст есть
 * только в журнале общения, с вычищенными телефонами и почтами.
 *
 * Сторож: tests/unit/a2a-journal-admin.test.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { logText } from '@/lib/log/log-text';
import { a2aAgentKind, type A2aAgentKind } from '@/lib/a2a/journal';
import { RETENTION_DAYS } from '@/lib/a2a/dialog-log';
import { isProbeClient } from '@/lib/mcp/probe-clients';
import { BOT_FAMILIES } from '@/lib/analytics/bot-detect';

export const dynamic = 'force-dynamic';

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;
const RECENT_LIMIT = 50;
const DIALOG_LIMIT = 50;

export function readWindowDays(raw: string | null): number {
  const n = Number(raw ?? DEFAULT_DAYS);
  return Number.isInteger(n) && n >= 1 && n <= MAX_DAYS ? n : DEFAULT_DAYS;
}

/** Семейства счётчика входов, которых нет в реестре вендоров (lib/analytics/bot-detect). */
export const PSEUDO_FAMILY_LABELS: Record<string, string> = {
  'other-bot': 'прочие обходчики (назвались ботом, вендор не в реестре)',
  tool: 'инструменты разработчика (curl, python, wget)',
  browser: 'браузеры',
  none: 'без заголовка',
  unknown: 'не опознан',
};

type Block<T> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * Блок читается сам по себе: отказ одного — не отказ среза. Имя и SQLSTATE
 * уходят в лог, наружу — «не прочиталось» с кодом, не пустой список.
 */
async function block<T>(name: string, read: () => Promise<T>): Promise<Block<T>> {
  try {
    return { ok: true, ...(await read()) };
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    const sqlstate = typeof code === 'string' ? logText(code, 10) : 'нет';
    console.error(`[admin/analytics/a2a] блок ${name} не прочитался: SQLSTATE=${sqlstate}`, logText(err instanceof Error ? err.message : err, 200));
    return { ok: false, error: `не прочиталось (SQLSTATE=${sqlstate})` };
  }
}

interface A2aAgentRow {
  agent: string; ua_family: string; is_self: boolean;
  requests: number; sends: number; text_sends: number; tool_sends: number;
  completed: number; rejected: number; failed: number; protocol_errors: number; card_reads: number;
  dialogs: number; caller_days: number; versions: string; bindings: string;
  first_seen: string; last_seen: string;
}
interface A2aDayRow { day: string; requests: number; agents: number }
interface A2aToolRow { tool: string; calls: number; completed: number; rejected: number; failed: number; agents: number }
interface A2aRecentRow {
  at: string; binding: string; op: string; version: string; version_declared: boolean; ok: boolean;
  error_code: string | null; method: string | null; input: string | null; tool: string | null; state: string | null;
  duration_ms: number | null; agent: string; ua_family: string; is_self: boolean;
}
interface BoundsRow { since: string | null; total: number }
interface DialogRow {
  at: string; agent: string; ua_family: string; is_self: boolean; context_key: string | null;
  turn: number; question: string; answer: string; state: string; duration_ms: number | null;
}
interface McpClientRow { client_name: string | null; ua_family: string | null; caller_days: number; days: number; first_seen: string | null; last_seen: string | null }
interface EntryFamilyRow { family: string; hits: number; paths: number; last_day: string }

const WINDOW = `created_at >= NOW() - ($1::int * INTERVAL '1 day')`;
const KAM = `AT TIME ZONE 'Asia/Kamchatka'`;

export async function readA2a(days: number) {
  const [bounds, byAgent, byDay, byTool, recent] = await Promise.all([
    pool.query<BoundsRow>(`SELECT to_char(MIN(created_at) ${KAM}, 'YYYY-MM-DD') AS since, COUNT(*)::int AS total FROM a2a_requests`),
    pool.query<A2aAgentRow>(
      `SELECT agent, ua_family, is_self,
              COUNT(*)::int                                            AS requests,
              COUNT(*) FILTER (WHERE op = 'SendMessage')::int          AS sends,
              COUNT(*) FILTER (WHERE input = 'text')::int              AS text_sends,
              COUNT(*) FILTER (WHERE input = 'tool')::int              AS tool_sends,
              COUNT(*) FILTER (WHERE state = 'completed')::int         AS completed,
              COUNT(*) FILTER (WHERE state = 'rejected')::int          AS rejected,
              COUNT(*) FILTER (WHERE state = 'failed')::int            AS failed,
              COUNT(*) FILTER (WHERE NOT ok)::int                      AS protocol_errors,
              COUNT(*) FILTER (WHERE op = 'card')::int                 AS card_reads,
              COUNT(DISTINCT context_key)::int                         AS dialogs,
              COUNT(DISTINCT caller_hash)::int                         AS caller_days,
              array_to_string(array_agg(DISTINCT version), ',')        AS versions,
              array_to_string(array_agg(DISTINCT binding), ',')        AS bindings,
              to_char(MIN(created_at) ${KAM}, 'YYYY-MM-DD HH24:MI')    AS first_seen,
              to_char(MAX(created_at) ${KAM}, 'YYYY-MM-DD HH24:MI')    AS last_seen
         FROM a2a_requests
        WHERE ${WINDOW}
        GROUP BY agent, ua_family, is_self
        ORDER BY COUNT(*) DESC, MAX(created_at) DESC`,
      [days],
    ),
    pool.query<A2aDayRow>(
      `SELECT to_char((created_at ${KAM})::date, 'YYYY-MM-DD') AS day,
              COUNT(*)::int AS requests,
              COUNT(DISTINCT agent)::int AS agents
         FROM a2a_requests
        WHERE ${WINDOW}
        GROUP BY 1 ORDER BY 1`,
      [days],
    ),
    pool.query<A2aToolRow>(
      `SELECT tool,
              COUNT(*)::int AS calls,
              COUNT(*) FILTER (WHERE state = 'completed')::int AS completed,
              COUNT(*) FILTER (WHERE state = 'rejected')::int  AS rejected,
              COUNT(*) FILTER (WHERE state = 'failed')::int    AS failed,
              COUNT(DISTINCT agent)::int AS agents
         FROM a2a_requests
        WHERE tool IS NOT NULL AND ${WINDOW}
        GROUP BY tool ORDER BY COUNT(*) DESC, tool`,
      [days],
    ),
    pool.query<A2aRecentRow>(
      `SELECT to_char(created_at ${KAM}, 'YYYY-MM-DD HH24:MI:SS') AS at,
              binding, op, version, version_declared, ok, error_code, method, input, tool, state, duration_ms, agent, ua_family, is_self
         FROM a2a_requests
        ORDER BY created_at DESC
        LIMIT $1::int`,
      [RECENT_LIMIT],
    ),
  ]);
  const b = bounds.rows[0] ?? { since: null, total: 0 };
  const byAgentRows = byAgent.rows.map((r) => ({
    ...r,
    kind: a2aAgentKind(r.agent, r.ua_family, r.is_self) as A2aAgentKind,
    versions: r.versions ? r.versions.split(',') : [],
    bindings: r.bindings ? r.bindings.split(',') : [],
  }));
  return {
    since: b.since,
    total_all_time: b.total,
    total_window: byAgentRows.reduce((s, r) => s + r.requests, 0),
    recent_limit: RECENT_LIMIT,
    by_agent: byAgentRows,
    by_day: byDay.rows,
    by_tool: byTool.rows,
    recent: recent.rows.map((r) => ({ ...r, kind: a2aAgentKind(r.agent, r.ua_family, r.is_self) })),
  };
}

/**
 * Журнал общения: последние реплики разговоров с Кузьмичом. Без окна — как
 * «последние запросы»: разговоров немного, и прятать вчерашний за окном в
 * семь суток незачем. Диалог показывается коротким ключом (8 знаков hash) —
 * чтобы видеть реплики одного разговора, не раскрывая contextId.
 */
export async function readDialogs() {
  const [bounds, rows] = await Promise.all([
    pool.query<BoundsRow>(`SELECT to_char(MIN(created_at) ${KAM}, 'YYYY-MM-DD') AS since, COUNT(*)::int AS total FROM a2a_dialogs`),
    pool.query<DialogRow>(
      `SELECT to_char(created_at ${KAM}, 'YYYY-MM-DD HH24:MI:SS') AS at,
              agent, ua_family, is_self, context_key, turn, question, answer, state, duration_ms
         FROM a2a_dialogs
        ORDER BY created_at DESC
        LIMIT $1::int`,
      [DIALOG_LIMIT],
    ),
  ]);
  const b = bounds.rows[0] ?? { since: null, total: 0 };
  return {
    since: b.since,
    total: b.total,
    retention_days: RETENTION_DAYS,
    limit: DIALOG_LIMIT,
    items: rows.rows.map((r) => ({
      at: r.at,
      agent: r.agent,
      kind: a2aAgentKind(r.agent, r.ua_family, r.is_self),
      dialog: r.context_key ? r.context_key.slice(0, 8) : null,
      turn: r.turn,
      question: r.question,
      answer: r.answer,
      state: r.state,
      duration_ms: r.duration_ms,
    })),
  };
}

export async function readMcp(days: number) {
  const res = await pool.query<McpClientRow>(
    `SELECT client_name, ua_family,
            COUNT(*)::int AS caller_days,
            COUNT(DISTINCT day)::int AS days,
            to_char(MIN(first_seen) ${KAM}, 'YYYY-MM-DD') AS first_seen,
            to_char(MAX(last_seen) ${KAM}, 'YYYY-MM-DD HH24:MI') AS last_seen
       FROM mcp_clients
      WHERE day >= CURRENT_DATE - ($1::int - 1)
      GROUP BY client_name, ua_family
      ORDER BY COUNT(*) DESC, MAX(last_seen) DESC`,
    [days],
  );
  return {
    clients: res.rows.map((r) => ({
      client: r.client_name ?? r.ua_family ?? 'не представился',
      kind: r.client_name ? 'представился' : (r.ua_family ? 'по заголовку' : 'неизвестно'),
      origin: isProbeClient(r.client_name, r.ua_family) ? 'probe' : 'external',
      caller_days: r.caller_days,
      days: r.days,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
    })),
  };
}

export async function readEntries(days: number) {
  const vendorOf = new Map(BOT_FAMILIES.map((f) => [f.family, f.vendor]));
  const [bounds, byFamily] = await Promise.all([
    pool.query<BoundsRow>(`SELECT MIN(day)::text AS since, COALESCE(SUM(hits), 0)::int AS total FROM agent_entry_hits`),
    pool.query<EntryFamilyRow>(
      `SELECT family, SUM(hits)::int AS hits, COUNT(DISTINCT path)::int AS paths, MAX(day)::text AS last_day
         FROM agent_entry_hits
        WHERE day >= CURRENT_DATE - ($1::int - 1)
        GROUP BY family
        ORDER BY SUM(hits) DESC, family`,
      [days],
    ),
  ]);
  const b = bounds.rows[0] ?? { since: null, total: 0 };
  const families = byFamily.rows.map((r) => ({
    family: r.family,
    vendor: vendorOf.get(r.family) ?? PSEUDO_FAMILY_LABELS[r.family] ?? null,
    hits: r.hits,
    paths: r.paths,
    last_day: r.last_day,
  }));
  return { since: b.since, total_all_time: b.total, total_window: families.reduce((s, f) => s + f.hits, 0), by_family: families };
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const days = readWindowDays(request.nextUrl.searchParams.get('days'));
  const [a2a, mcp, entries, dialogs] = await Promise.all([
    block('a2a', () => readA2a(days)),
    block('mcp', () => readMcp(days)),
    block('entries', () => readEntries(days)),
    block('dialogs', () => readDialogs()),
  ]);
  const degraded = (['a2a', 'mcp', 'entries', 'dialogs'] as const).filter((k) => !({ a2a, mcp, entries, dialogs })[k].ok);

  return NextResponse.json({
    success: true,
    window_days: days,
    generated_at: new Date().toISOString(),
    a2a,
    mcp,
    entries,
    dialogs,
    // Что не прочиталось — названо; пустой список здесь значит «все блоки прочитаны».
    degraded,
    note:
      'Самоназвание агента — из заголовка User-Agent (имя программы, не строка целиком); ' +
      'клиент MCP — из его рукопожатия. Сырых User-Agent и IP не хранит ни один журнал. ' +
      `Текст есть только в журнале общения A2A: вопрос и ответ с вычищенными телефонами и почтами, ${RETENTION_DAYS} суток. ` +
      'Аргументы инструментов не хранятся. Сутки — камчатские.',
  });
}
