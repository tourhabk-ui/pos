/**
 * Сводка суток для обзора админки (слово владельца 22.10: «в главной
 * админской панели покажи числа: люди, MCP и A2A и кол-во взаимодействий с
 * Кузьмичом за сутки»).
 *
 * Четыре числа за камчатские сутки «сегодня» и «вчера», каждое — своим
 * запросом и со своим исходом: одно не прочиталось — остальные стоят, а у
 * несчитанного вместо числа ошибка (§4.0: «не загрузилось» ≠ 0).
 *
 * Правила счёта — те же, что на подробных страницах, а не свои:
 * - люди — уникальные посетители `page_views` без ботов и своих заходов,
 *   как визиты воронки (lib/analytics/funnel-window);
 * - MCP — внешние вызовы: без метки владельца и без проверок
 *   (lib/mcp/probe-clients), как на /hub/admin/mcp;
 * - A2A — обращения внешних агентов без чтения визитки (op = 'card'), без
 *   своих, реестра A2A и проб (lib/a2a/agent-kind), как на /hub/admin/a2a;
 * - Кузьмич — ответы (`ai_actions_log`, `kuzmich_answer`, по строке на ответ
 *   на любой поверхности, пишется с 15.10). Метки «свой» у ответа нет: ответы
 *   владельцу в числе — так и подписано на экране.
 */
import { pool } from '@/lib/db-pool';
import { kamchatkaDate, kamchatkaDayStart, shiftDate } from '@/lib/analytics/kamchatka-day';
import { PROBE_PARAMS, probeCallSql } from '@/lib/mcp/probe-clients';
import { A2A_EXTERNAL_PARAMS, a2aExternalSql } from '@/lib/a2a/agent-kind';
import { KUZMICH_ANSWER_ACTION } from '@/lib/kuzmich/answer-ceiling';

export type { Metric, DaySummary } from '@/lib/analytics/day-summary-types';
import type { Metric, DaySummary } from '@/lib/analytics/day-summary-types';

/** Границы окон: [вчера, сегодня) и [сегодня, сейчас]. */
export function dayWindows(now: Date): { today: string; yesterday: string; from: Date; split: Date; to: Date } {
  const today = kamchatkaDate(now);
  const yesterday = shiftDate(today, -1);
  return { today, yesterday, from: kamchatkaDayStart(yesterday), split: kamchatkaDayStart(today), to: now };
}

type Day = 'today' | 'yesterday';
const DAY_OF = (col: string, splitParam: string) => `CASE WHEN ${col} >= ${splitParam}::timestamptz THEN 'today' ELSE 'yesterday' END`;

async function settle<T>(name: string, run: () => Promise<{ today: T; yesterday: T }>): Promise<Metric<T>> {
  try {
    return { ok: true, ...(await run()) };
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown } | null;
    console.error(`[day-summary] ${name} не прочитано:`, typeof e?.code === 'string' ? e.code : 'нет SQLSTATE',
      typeof e?.message === 'string' ? e.message.slice(0, 200) : '');
    return { ok: false, error: 'не загрузилось' };
  }
}

function pick<R extends { d: Day }, T>(rows: R[], empty: T, map: (r: R) => T): { today: T; yesterday: T } {
  const by = new Map(rows.map((r) => [r.d, r]));
  const at = (d: Day) => { const r = by.get(d); return r ? map(r) : empty; };
  return { today: at('today'), yesterday: at('yesterday') };
}

export async function readDaySummary(now: Date = new Date()): Promise<DaySummary> {
  const w = dayWindows(now);
  const [people, mcp, a2a, kuzmich] = await Promise.all([
    settle('люди', async () => {
      const { rows } = await pool.query<{ d: Day; visitors: number; views: number; bot_views: number }>(
        `SELECT ${DAY_OF('created_at', '$2')} AS d,
                COUNT(DISTINCT visitor_hash) FILTER (WHERE is_bot = FALSE AND is_self = FALSE)::int AS visitors,
                COUNT(*) FILTER (WHERE is_bot = FALSE AND is_self = FALSE)::int                     AS views,
                COUNT(*) FILTER (WHERE is_bot = TRUE)::int                                          AS bot_views
           FROM page_views
          WHERE created_at >= $1::timestamptz AND created_at <= $3::timestamptz
          GROUP BY 1`,
        [w.from, w.split, w.to],
      );
      return pick(rows, { visitors: 0, views: 0, bot_views: 0 }, (r) => ({ visitors: r.visitors, views: r.views, bot_views: r.bot_views }));
    }),
    settle('MCP', async () => {
      const { rows } = await pool.query<{ d: Day; calls: number; callers: number }>(
        `SELECT ${DAY_OF('t.created_at', '$5')} AS d,
                COUNT(*)::int AS calls, COUNT(DISTINCT t.caller_hash)::int AS callers
           FROM mcp_tool_calls t
          WHERE t.created_at >= $4::timestamptz AND t.created_at <= $6::timestamptz
            AND t.is_self = FALSE AND NOT ${probeCallSql('t', '$1', '$2', '$3')}
          GROUP BY 1`,
        [...PROBE_PARAMS, w.from, w.split, w.to],
      );
      return pick(rows, { calls: 0, callers: 0 }, (r) => ({ calls: r.calls, callers: r.callers }));
    }),
    settle('A2A', async () => {
      const { rows } = await pool.query<{ d: Day; requests: number; callers: number }>(
        `SELECT ${DAY_OF('r.created_at', '$4')} AS d,
                COUNT(*)::int AS requests, COUNT(DISTINCT r.caller_hash)::int AS callers
           FROM a2a_requests r
          WHERE r.created_at >= $3::timestamptz AND r.created_at <= $5::timestamptz
            AND r.op <> 'card' AND ${a2aExternalSql('r', '$1', '$2')}
          GROUP BY 1`,
        [...A2A_EXTERNAL_PARAMS, w.from, w.split, w.to],
      );
      return pick(rows, { requests: 0, callers: 0 }, (r) => ({ requests: r.requests, callers: r.callers }));
    }),
    settle('Кузьмич', async () => {
      const { rows } = await pool.query<{ d: Day; surface: string; n: number }>(
        `SELECT ${DAY_OF('created_at', '$3')} AS d,
                COALESCE(metadata->>'surface', 'other') AS surface, COUNT(*)::int AS n
           FROM ai_actions_log
          WHERE action_type = $1 AND created_at >= $2::timestamptz AND created_at <= $4::timestamptz
          GROUP BY 1, 2`,
        [KUZMICH_ANSWER_ACTION, w.from, w.split, w.to],
      );
      const day = (d: Day) => {
        const by_surface: Record<string, number> = {};
        let answers = 0;
        for (const r of rows) if (r.d === d) { by_surface[r.surface] = r.n; answers += r.n; }
        return { answers, by_surface };
      };
      return { today: day('today'), yesterday: day('yesterday') };
    }),
  ]);
  return { today: w.today, yesterday: w.yesterday, people, mcp, a2a, kuzmich };
}
