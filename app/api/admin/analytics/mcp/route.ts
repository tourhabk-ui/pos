/**
 * GET /api/admin/analytics/mcp — срез MCP-канала (Рост-6, оценка 14.08:
 * vedar-mcp — четвёртый измеряемый канал).
 *
 * Источник — mcp_tool_calls (журнал фактов вызова, без аргументов и без ПД).
 * Отвечает: зовут ли инструменты, какие, ломаются ли, сколько занимают.
 * caller_hash СУТОЧНЫЙ (тот же приём, что page_views/funnel_events, 152-ФЗ):
 * «уникальные вызывающие» за период — сумма человеко-дней, не люди.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { PROBE_PARAMS, probeCallSql } from '@/lib/mcp/probe-clients';

/**
 * Внешний вызов — не свой (метка владельца, is_self) и не проверка (смоук,
 * пробы, curl — реестр lib/mcp/probe-clients). Решение владельца 02.10: три
 * числа вместо одного, иначе 416 вызовов смоука читались как спрос.
 */
const EXTERNAL = (t: string) => `${t}.is_self = FALSE AND NOT ${probeCallSql(t, '$1', '$2', '$3')}`;

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const [byTool, daily, errors, clients, unknownTools, origins, errorDetail] = await Promise.all([
      pool.query<{
        tool: string; calls_7d: string; errors_7d: string; calls_30d: string;
        errors_30d: string; avg_ms: string | null; max_ms: string | null; callers_30d: string;
      }>(
        `SELECT tool,
                COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')                AS calls_7d,
                COUNT(*) FILTER (WHERE NOT ok AND created_at >= NOW() - INTERVAL '7 days')     AS errors_7d,
                COUNT(*)                                                                        AS calls_30d,
                COUNT(*) FILTER (WHERE NOT ok)                                                  AS errors_30d,
                ROUND(AVG(duration_ms) FILTER (WHERE ok))                                       AS avg_ms,
                MAX(duration_ms)                                                                AS max_ms,
                COUNT(DISTINCT caller_hash)                                                     AS callers_30d
           FROM mcp_tool_calls t
          WHERE created_at >= NOW() - INTERVAL '30 days' AND ${EXTERNAL('t')}
          GROUP BY tool ORDER BY COUNT(*) DESC`,
        PROBE_PARAMS,
      ),
      pool.query<{ day: string; calls: string; errors: string; callers: string }>(
        `SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day,
                COUNT(*) AS calls,
                COUNT(*) FILTER (WHERE NOT ok) AS errors,
                COUNT(DISTINCT caller_hash) AS callers
           FROM mcp_tool_calls t
          WHERE created_at >= NOW() - INTERVAL '14 days' AND ${EXTERNAL('t')}
          GROUP BY created_at::date ORDER BY created_at::date`,
        PROBE_PARAMS,
      ),
      pool.query<{ error_kind: string; d30: string }>(
        `SELECT error_kind, COUNT(*) AS d30
           FROM mcp_tool_calls t
          WHERE NOT ok AND created_at >= NOW() - INTERVAL '30 days' AND ${EXTERNAL('t')}
          GROUP BY error_kind ORDER BY COUNT(*) DESC`,
        PROBE_PARAMS,
      ),
      /**
       * КТО звал. Соединение по суточному ключу (caller_hash, day) — тому же,
       * которым живёт журнал вызовов, поэтому окно наблюдения не расширяется:
       * профиля за пределами суток по-прежнему нет.
       *
       * Имя берётся из самопредставления клиента (`initialize.clientInfo`),
       * род из заголовка — на подхвате, когда рукопожатия не было. Обе
       * величины про ПРОГРАММУ, не про человека.
       *
       * LEFT JOIN намеренный: вызовы, сделанные до 18.08 (или клиентом, о
       * котором мы ничего не знаем), обязаны остаться в счёте под честным
       * «не представился», а не исчезнуть из отчёта.
       */
      pool.query<{ client: string; kind: string; origin: string; calls: string; caller_days: string; last_seen: string | null }>(
        `SELECT COALESCE(c.client_name, c.ua_family, 'не представился') AS client,
                CASE WHEN c.client_name IS NOT NULL THEN 'представился'
                     WHEN c.ua_family  IS NOT NULL THEN 'по заголовку'
                     ELSE 'неизвестно' END                              AS kind,
                CASE WHEN t.is_self THEN 'self'
                     WHEN c.client_name = ANY($1::text[])
                       OR c.client_name ~* $3::text
                       OR (c.client_name IS NULL AND c.ua_family = ANY($2::text[])) THEN 'probe'
                     ELSE 'external' END                                AS origin,
                COUNT(*)                                                AS calls,
                COUNT(DISTINCT t.caller_hash)                           AS caller_days,
                to_char(MAX(c.last_seen), 'YYYY-MM-DD HH24:MI')         AS last_seen
           FROM mcp_tool_calls t
           LEFT JOIN mcp_clients c
                  ON c.caller_hash = t.caller_hash
                 AND c.day = t.created_at::date
          WHERE t.created_at >= NOW() - INTERVAL '30 days'
          GROUP BY 1, 2, 3
          ORDER BY COUNT(*) DESC`,
        PROBE_PARAMS,
      ),
      // Какие НЕСУЩЕСТВУЮЩИЕ инструменты просили (миграция 1141). До неё все
      // такие запросы были одной строкой 'unknown' — переименовывать или
      // заводить алиас было нечего.
      pool.query<{ requested_tool: string; d30: string; last_seen: string }>(
        `SELECT requested_tool, COUNT(*) AS d30, to_char(MAX(created_at), 'YYYY-MM-DD') AS last_seen
           FROM mcp_tool_calls t
          WHERE error_kind = 'unknown_tool' AND requested_tool IS NOT NULL
            AND created_at >= NOW() - INTERVAL '30 days' AND ${EXTERNAL('t')}
          GROUP BY requested_tool ORDER BY COUNT(*) DESC LIMIT 20`,
        PROBE_PARAMS,
      ),
      // Три числа вместо одного: внешние, свои (метка владельца), проверки.
      // И с какого дня метка «свой» ставилась: до него свои и чужие в
      // журнале неразличимы, и перепись за прошлое остаётся смешанной.
      pool.query<{ external: string; self: string; probe: string; self_since: string | null }>(
        `SELECT COUNT(*) FILTER (WHERE ${EXTERNAL('t')})                 AS external,
                COUNT(*) FILTER (WHERE t.is_self)                        AS self,
                COUNT(*) FILTER (WHERE t.is_self = FALSE AND ${probeCallSql('t', '$1', '$2', '$3')}) AS probe,
                to_char(MIN(t.created_at) FILTER (WHERE t.is_self), 'YYYY-MM-DD') AS self_since
           FROM mcp_tool_calls t
          WHERE t.created_at >= NOW() - INTERVAL '30 days'`,
        PROBE_PARAMS,
      ),
      // Причина, не только счётчик (1143): код и главный аргумент. Значение
      // аргумента есть только у читающих инструментов и не бывает телефоном —
      // так пишет lib/mcp/call-reason, панель это не переделывает.
      pool.query<{ tool: string; error_kind: string | null; error_code: string | null; arg_key: string | null; arg_value: string | null; n: string; last_at: string }>(
        `SELECT t.tool, t.error_kind, t.error_code, t.arg_key, t.arg_value,
                COUNT(*) AS n, to_char(MAX(t.created_at), 'YYYY-MM-DD') AS last_at
           FROM mcp_tool_calls t
          WHERE NOT t.ok AND t.created_at >= NOW() - INTERVAL '30 days' AND ${EXTERNAL('t')}
          GROUP BY 1, 2, 3, 4, 5
          ORDER BY COUNT(*) DESC, MAX(t.created_at) DESC
          LIMIT 40`,
        PROBE_PARAMS,
      ),
    ]);

    return NextResponse.json({
      by_tool_30d: byTool.rows.map((r) => ({
        tool: r.tool,
        calls_7d: Number(r.calls_7d),
        errors_7d: Number(r.errors_7d),
        calls_30d: Number(r.calls_30d),
        errors_30d: Number(r.errors_30d),
        avg_ms: r.avg_ms === null ? null : Number(r.avg_ms),
        max_ms: r.max_ms === null ? null : Number(r.max_ms),
        caller_days_30d: Number(r.callers_30d),
      })),
      daily_14d: daily.rows.map((r) => ({
        day: r.day,
        calls: Number(r.calls),
        errors: Number(r.errors),
        caller_days: Number(r.callers),
      })),
      errors_by_kind_30d: errors.rows.map((r) => ({
        kind: r.error_kind,
        d30: Number(r.d30),
      })),
      errors_detail_30d: errorDetail.rows.map((r) => ({
        tool: r.tool,
        error_kind: r.error_kind,
        error_code: r.error_code,
        arg_key: r.arg_key,
        arg_value: r.arg_value,
        n: Number(r.n),
        last_at: r.last_at,
      })),
      unknown_tools_30d: unknownTools.rows.map((r) => ({
        requested_tool: r.requested_tool,
        d30: Number(r.d30),
        last_seen: r.last_seen,
      })),
      origins_30d: {
        external: Number(origins.rows[0]?.external ?? 0),
        self: Number(origins.rows[0]?.self ?? 0),
        probe: Number(origins.rows[0]?.probe ?? 0),
        self_since: origins.rows[0]?.self_since ?? null,
      },
      by_client_30d: clients.rows.map((r) => ({
        client: r.client,
        kind: r.kind,
        origin: r.origin,
        calls: Number(r.calls),
        caller_days: Number(r.caller_days),
        last_seen: r.last_seen,
      })),
      window_note:
        'caller_hash суточный (152-ФЗ): caller_days — человеко-дни, ' +
        'а не уникальные вызывающие за период. Имя клиента — из его ' +
        'самопредставления при рукопожатии MCP: это имя программы, не человека. ' +
        'Таблицы по инструментам, дням и ошибкам — только внешние вызовы: без своих ' +
        '(метка владельца) и без проверок (смоук, пробы, curl).',
    });
  } catch {
    return NextResponse.json({ error: 'Не удалось построить срез MCP' }, { status: 500 });
  }
}
