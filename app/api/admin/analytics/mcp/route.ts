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

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const [byTool, daily, errors, clients] = await Promise.all([
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
           FROM mcp_tool_calls
          WHERE created_at >= NOW() - INTERVAL '30 days'
          GROUP BY tool ORDER BY COUNT(*) DESC`,
      ),
      pool.query<{ day: string; calls: string; errors: string; callers: string }>(
        `SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day,
                COUNT(*) AS calls,
                COUNT(*) FILTER (WHERE NOT ok) AS errors,
                COUNT(DISTINCT caller_hash) AS callers
           FROM mcp_tool_calls
          WHERE created_at >= NOW() - INTERVAL '14 days'
          GROUP BY created_at::date ORDER BY created_at::date`,
      ),
      pool.query<{ error_kind: string; d30: string }>(
        `SELECT error_kind, COUNT(*) AS d30
           FROM mcp_tool_calls
          WHERE NOT ok AND created_at >= NOW() - INTERVAL '30 days'
          GROUP BY error_kind ORDER BY COUNT(*) DESC`,
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
      pool.query<{ client: string; kind: string; calls: string; caller_days: string; last_seen: string | null }>(
        `SELECT COALESCE(c.client_name, c.ua_family, 'не представился') AS client,
                CASE WHEN c.client_name IS NOT NULL THEN 'представился'
                     WHEN c.ua_family  IS NOT NULL THEN 'по заголовку'
                     ELSE 'неизвестно' END                              AS kind,
                COUNT(*)                                                AS calls,
                COUNT(DISTINCT t.caller_hash)                           AS caller_days,
                to_char(MAX(c.last_seen), 'YYYY-MM-DD HH24:MI')         AS last_seen
           FROM mcp_tool_calls t
           LEFT JOIN mcp_clients c
                  ON c.caller_hash = t.caller_hash
                 AND c.day = t.created_at::date
          WHERE t.created_at >= NOW() - INTERVAL '30 days'
          GROUP BY 1, 2
          ORDER BY COUNT(*) DESC`,
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
      by_client_30d: clients.rows.map((r) => ({
        client: r.client,
        kind: r.kind,
        calls: Number(r.calls),
        caller_days: Number(r.caller_days),
        last_seen: r.last_seen,
      })),
      window_note:
        'caller_hash суточный (152-ФЗ): caller_days — человеко-дни, ' +
        'а не уникальные вызывающие за период. Имя клиента — из его ' +
        'самопредставления при рукопожатии MCP: это имя программы, не человека.',
    });
  } catch {
    return NextResponse.json({ error: 'Не удалось построить срез MCP' }, { status: 500 });
  }
}
