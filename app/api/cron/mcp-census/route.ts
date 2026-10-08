/**
 * GET /api/cron/mcp-census — перепись журнала MCP с раннера. Только чтение.
 *
 * Владелец 02.10: «читать журнал как спрос нельзя: из 1190 вызовов за 30
 * дней 416 — свой смоук, ещё десятки — пробы и curl». Панель
 * /hub/admin/mcp закрыта admin-JWT и с раннера недостижима, а prod-check
 * умеет ходить только в /api/cron/* с CRON_SECRET. Эта перепись отдаёт то
 * же разделение, что панель (lib/mcp/probe-clients, is_self миграции 1142),
 * плюс то, чего панели не нужно на экране, а разбору нужно:
 *
 *  - вызовы по инструменту × род × ПРИЧИНА ошибки (1143) — только внешние;
 *  - каждый вызов пишущих инструментов за окно поимённо (без аргументов —
 *    их в журнале нет by construction): когда, чем кончился, причина, свой ли;
 *  - внешние ошибки по КЛИЕНТУ (08.10): двенадцать отказов `invalid_args`
 *    с пустыми аргументами нельзя было ни приписать, ни отличить от пробы —
 *    чей это мост, отвечает имя программы из рукопожатия;
 *  - с какого дня стоят метки «свой», «причина» — до них разделения нет,
 *    и перепись это называет числом строк без метки, а не молчит.
 *
 * Ничего не пишет ни при каком аргументе — сторож tests/unit/mcp-census.test.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { PROBE_PARAMS, probeCallSql } from '@/lib/mcp/probe-clients';
import { WRITE_TOOL_NAMES } from '@/lib/mcp/public-tools';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const PROBE = probeCallSql('t', '$1', '$2', '$3');
const ORIGIN = `CASE WHEN t.is_self THEN 'self' WHEN ${PROBE} THEN 'probe' ELSE 'external' END`;

interface Measured<T> { value: T | null; failed: string | null }

async function measure<T>(name: string, fn: () => Promise<T>): Promise<Measured<T>> {
  try {
    return { value: await fn(), failed: null };
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error(`[mcp-census] замер «${name}» не удался:`, e?.message ?? 'неизвестная ошибка', `SQLSTATE=${e?.code ?? 'нет'}`);
    return { value: null, failed: `${e?.code ?? 'ERR'}: ${e?.message ?? 'неизвестная ошибка'}` };
  }
}

export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const daysRaw = Number(req.nextUrl.searchParams.get('days') ?? '30');
  const days = Number.isFinite(daysRaw) && daysRaw >= 1 && daysRaw <= 90 ? Math.floor(daysRaw) : 30;
  // Окно — $4; $1..$3 заняты реестром проверок. Запрос, которому реестр не
  // нужен (marks), параметры реестра НЕ получает: PostgreSQL не выводит тип
  // параметра, которого нет в тексте (42P18, run 78), а PREPARE с явными
  // типами на локальной базе эту ошибку не показал.
  const W = `t.created_at >= NOW() - ($4 || ' days')::interval`;
  const p = [...PROBE_PARAMS, String(days)];
  const startedAt = Date.now();

  const [origins, byTool, errors, errorsByClient, requested, clients, writes, marks] = await Promise.all([
    measure('origins', async () => (await pool.query<{ origin: string; calls: string; errors: string; caller_days: string }>(
      `SELECT ${ORIGIN} AS origin, COUNT(*) AS calls, COUNT(*) FILTER (WHERE NOT t.ok) AS errors,
              COUNT(DISTINCT t.caller_hash) AS caller_days
         FROM mcp_tool_calls t WHERE ${W} GROUP BY 1 ORDER BY 1`, p)).rows),

    measure('by_tool_external', async () => (await pool.query<{ tool: string; calls: string; errors: string; caller_days: string }>(
      `SELECT t.tool, COUNT(*) AS calls, COUNT(*) FILTER (WHERE NOT t.ok) AS errors, COUNT(DISTINCT t.caller_hash) AS caller_days
         FROM mcp_tool_calls t WHERE ${W} AND t.is_self = FALSE AND NOT ${PROBE}
        GROUP BY 1 ORDER BY COUNT(*) DESC`, p)).rows),

    measure('errors_external', async () => (await pool.query<{ tool: string; error_kind: string | null; error_code: string | null; arg_key: string | null; arg_value: string | null; n: string; last_at: string }>(
      `SELECT t.tool, t.error_kind, t.error_code, t.arg_key, t.arg_value, COUNT(*) AS n, to_char(MAX(t.created_at), 'YYYY-MM-DD HH24:MI') AS last_at
         FROM mcp_tool_calls t WHERE ${W} AND NOT t.ok AND t.is_self = FALSE AND NOT ${PROBE}
        GROUP BY 1, 2, 3, 4, 5 ORDER BY COUNT(*) DESC LIMIT 60`, p)).rows),

    // Чей вызов упал или получил отказ: имя программы из рукопожатия, иначе
    // род заголовка. Это имя клиента, не человека, — то же, что в «clients».
    measure('errors_by_client_external', async () => (await pool.query<{ client: string; tool: string; error_kind: string | null; error_code: string | null; n: string; last_at: string }>(
      `SELECT COALESCE(c.client_name, c.ua_family, 'не представился') AS client, t.tool, t.error_kind, t.error_code,
              COUNT(*) AS n, to_char(MAX(t.created_at), 'YYYY-MM-DD HH24:MI') AS last_at
         FROM mcp_tool_calls t
         LEFT JOIN mcp_clients c ON c.caller_hash = t.caller_hash AND c.day = t.created_at::date
        WHERE ${W} AND NOT t.ok AND t.is_self = FALSE AND NOT ${PROBE}
        GROUP BY 1, 2, 3, 4 ORDER BY COUNT(*) DESC LIMIT 60`, p)).rows),

    measure('requested_unknown', async () => (await pool.query<{ requested_tool: string | null; origin: string; n: string }>(
      `SELECT t.requested_tool, ${ORIGIN} AS origin, COUNT(*) AS n
         FROM mcp_tool_calls t WHERE ${W} AND t.error_kind = 'unknown_tool'
        GROUP BY 1, 2 ORDER BY COUNT(*) DESC LIMIT 40`, p)).rows),

    measure('clients', async () => (await pool.query<{ client: string; origin: string; calls: string; caller_days: string; last_seen: string | null }>(
      `SELECT COALESCE(c.client_name, c.ua_family, 'не представился') AS client, ${ORIGIN} AS origin,
              COUNT(*) AS calls, COUNT(DISTINCT t.caller_hash) AS caller_days, to_char(MAX(c.last_seen), 'YYYY-MM-DD') AS last_seen
         FROM mcp_tool_calls t
         LEFT JOIN mcp_clients c ON c.caller_hash = t.caller_hash AND c.day = t.created_at::date
        WHERE ${W} GROUP BY 1, 2 ORDER BY COUNT(*) DESC`, p)).rows),

    // Пишущие — поимённо: их за месяц единицы, и каждый стоит разбора.
    measure('write_calls', async () => (await pool.query<{ at: string; tool: string; ok: boolean; error_kind: string | null; error_code: string | null; arg_key: string | null; origin: string; duration_ms: number | null }>(
      `SELECT to_char(t.created_at, 'YYYY-MM-DD HH24:MI') AS at, t.tool, t.ok, t.error_kind, t.error_code, t.arg_key, ${ORIGIN} AS origin, t.duration_ms
         FROM mcp_tool_calls t WHERE ${W} AND t.tool = ANY($5::text[])
        ORDER BY t.created_at DESC LIMIT 100`, [...p, [...WRITE_TOOL_NAMES]])).rows),


    // refused_since — по всему журналу, не по окну: до первой строки рода
    // `refused` (#2191, 02.10) отказ по входу писался сбоем.
    measure('marks', async () => (await pool.query<{ self_since: string | null; code_since: string | null; refused_since: string | null; rows_total: string; rows_without_code: string }>(
      `SELECT to_char(MIN(t.created_at) FILTER (WHERE t.is_self), 'YYYY-MM-DD') AS self_since,
              to_char(MIN(t.created_at) FILTER (WHERE t.error_code IS NOT NULL), 'YYYY-MM-DD') AS code_since,
              (SELECT to_char(MIN(r.created_at), 'YYYY-MM-DD HH24:MI') FROM mcp_tool_calls r WHERE r.error_kind = 'refused') AS refused_since,
              COUNT(*) AS rows_total,
              COUNT(*) FILTER (WHERE NOT t.ok AND t.error_code IS NULL) AS rows_without_code
         FROM mcp_tool_calls t WHERE t.created_at >= NOW() - ($1 || ' days')::interval`, [String(days)])).rows[0]),
  ]);

  const failed = ([['origins', origins], ['by_tool_external', byTool], ['errors_external', errors], ['errors_by_client_external', errorsByClient], ['requested_unknown', requested], ['clients', clients], ['write_calls', writes], ['marks', marks]] as const)
    .filter(([, m]) => m.failed !== null)
    .map(([name, m]) => ({ measure: name, error: m.failed }));

  const num = <T extends Record<string, unknown>>(rows: T[] | null) =>
    rows?.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && /^\d+$/.test(v) && ['calls', 'errors', 'caller_days', 'n', 'rows_total', 'rows_without_code'].includes(k) ? Number(v) : v]))) ?? null;

  return NextResponse.json({
    ok: failed.length === 0,
    window_days: days,
    generated_at: new Date().toISOString(),
    // Три числа, не одно: external — спрос, self — метка владельца, probe — смоук, пробы, curl.
    origins: num(origins.value),
    by_tool_external: num(byTool.value),
    errors_external: num(errors.value),
    errors_by_client_external: num(errorsByClient.value),
    requested_unknown: num(requested.value),
    clients: num(clients.value),
    write_calls: writes.value,
    marks: marks.value ? {
      self_since: marks.value.self_since,
      error_code_since: marks.value.code_since,
      refused_since: marks.value.refused_since,
      rows_total: Number(marks.value.rows_total),
      errors_without_code: Number(marks.value.rows_without_code),
    } : null,
    failed_measures: failed,
    note:
      'Только чтение. Разделение свой/проверка/внешний — то же, что в панели ' +
      '(is_self миграции 1142, реестр lib/mcp/probe-clients). До self_since свои ' +
      'вызовы неотличимы от внешних; до error_code_since у ошибок нет причины; ' +
      'до refused_since отказ по входу писался как execution. ' +
      'caller_days — человеко-дни суточного hash, не люди.',
    duration_ms: Date.now() - startedAt,
  });
}
