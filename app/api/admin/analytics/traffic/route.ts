/**
 * GET /api/admin/analytics/traffic — посещаемость и ПОВЕДЕНИЕ из первичного
 * счётчика (page_views: PageViewTracker -> /api/analytics/hit + /dwell).
 *
 * Три честности, которых тут раньше не было:
 *   1. Боты отделены от людей. Их не выбрасываем — показываем долей, потому что
 *      «сколько из этих просмотров вообще человеческие» это первый вопрос к
 *      любому счётчику (в источниках уже светился aisearchindex.space).
 *   2. «Уникальные» больше не выдаются за людей на длинном окне. Суточный
 *      visitor_hash содержит дату (152-ФЗ, длинный профиль не строим), поэтому
 *      DISTINCT за 30 дней — это человеко-дни: один и тот же человек, заходивший
 *      двадцать дней, даёт двадцать. Отдаём отдельно uniques_today (люди) и
 *      visitor_days (человеко-дни), а не одно число под двумя смыслами.
 *   3. Свои домены не считаются источником перехода. Прежний фильтр знал только
 *      vedarai.ru, и переходы со старого tourhab.ru выглядели притоком извне.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { safeMsg } from '@/lib/errors/sanitize';

export const dynamic = 'force-dynamic';

/** Свои хосты в SQL-регулярке — источник правды тот же, что у lib/analytics/bot-detect. */
const OWN_HOST_RE = 'vedarai\\.ru|tourhab\\.ru|tourhabk\\.ru|localhost';

/** Людские строки: во всех поведенческих выборках отсекаем ботов. */
const HUMAN = 'is_bot = FALSE';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const [totals, daily, topPaths, topReferrers, coverage, edges, pages, sessions, notFound] = await Promise.all([
      pool.query<{
        today_hits: string; today_uniques: string;
        week_hits: string; week_visitor_days: string;
        month_hits: string; month_visitor_days: string;
        month_bot_hits: string;
      }>(`
        SELECT
          COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE AND ${HUMAN}) AS today_hits,
          COUNT(DISTINCT visitor_hash) FILTER (WHERE created_at >= CURRENT_DATE AND ${HUMAN} AND visitor_hash IS NOT NULL) AS today_uniques,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days' AND ${HUMAN}) AS week_hits,
          COUNT(DISTINCT visitor_hash) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days' AND ${HUMAN} AND visitor_hash IS NOT NULL) AS week_visitor_days,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days' AND ${HUMAN}) AS month_hits,
          COUNT(DISTINCT visitor_hash) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days' AND ${HUMAN} AND visitor_hash IS NOT NULL) AS month_visitor_days,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days' AND is_bot) AS month_bot_hits
        FROM page_views
      `),
      pool.query<{ day: string; hits: string; uniques: string }>(`
        SELECT
          to_char(created_at::date, 'YYYY-MM-DD') AS day,
          COUNT(*) AS hits,
          COUNT(DISTINCT visitor_hash) FILTER (WHERE visitor_hash IS NOT NULL) AS uniques
        FROM page_views
        WHERE created_at >= NOW() - INTERVAL '14 days' AND ${HUMAN}
        GROUP BY created_at::date
        ORDER BY created_at::date DESC
      `),
      pool.query<{ path: string; hits: string }>(`
        SELECT path, COUNT(*) AS hits
        FROM page_views
        WHERE created_at >= NOW() - INTERVAL '30 days' AND ${HUMAN}
        GROUP BY path
        ORDER BY hits DESC
        LIMIT 15
      `),
      pool.query<{ referrer: string; hits: string }>(`
        SELECT referrer, COUNT(*) AS hits
        FROM page_views
        WHERE created_at >= NOW() - INTERVAL '30 days'
          AND ${HUMAN}
          AND referrer IS NOT NULL
          AND referrer !~* '${OWN_HOST_RE}'
        GROUP BY referrer
        ORDER BY hits DESC
        LIMIT 10
      `),
      // С какой даты у строк есть суточный хэш: до неё уники посчитать нельзя
      // (сырые IP не хранятся, 152-ФЗ). Дата — из данных, не хардкод.
      pool.query<{ uniques_since: string | null; has_unhashed: boolean }>(`
        SELECT
          to_char(MIN(created_at) FILTER (WHERE visitor_hash IS NOT NULL), 'YYYY-MM-DD') AS uniques_since,
          bool_or(visitor_hash IS NULL) AS has_unhashed
        FROM page_views
        WHERE created_at >= NOW() - INTERVAL '30 days'
      `),
      // Карта внутренних переходов: ребро (откуда -> куда) с весом.
      pool.query<{ from_path: string; to_path: string; hits: string }>(`
        SELECT from_path, path AS to_path, COUNT(*) AS hits
        FROM page_views
        WHERE created_at >= NOW() - INTERVAL '30 days'
          AND ${HUMAN}
          AND from_path IS NOT NULL
          AND from_path <> path
        GROUP BY from_path, path
        ORDER BY hits DESC
        LIMIT 25
      `),
      // Поведение на странице: время и доля выходов.
      // Выход = просмотр, после которого в этом же визите ничего не было.
      pool.query<{ path: string; views: string; median_ms: string | null; exits: string }>(`
        WITH v AS (
          SELECT id, path, session_id, dwell_ms, created_at,
                 LEAD(id) OVER (PARTITION BY session_id ORDER BY created_at) AS next_id
            FROM page_views
           WHERE created_at >= NOW() - INTERVAL '30 days' AND ${HUMAN}
        )
        SELECT path,
               COUNT(*) AS views,
               -- Медиана, а не среднее: одна забытая вкладка сдвигает среднее
               -- на минуты и превращает метрику в выдумку.
               percentile_cont(0.5) WITHIN GROUP (ORDER BY dwell_ms)
                 FILTER (WHERE dwell_ms IS NOT NULL)::bigint AS median_ms,
               COUNT(*) FILTER (WHERE session_id IS NOT NULL AND next_id IS NULL) AS exits
          FROM v
         GROUP BY path
        HAVING COUNT(*) >= 3
         ORDER BY views DESC
         LIMIT 15
      `),
      // Глубина визита: сколько страниц человек успевает посмотреть.
      pool.query<{ sessions: string; one_page: string; avg_depth: string | null }>(`
        WITH s AS (
          SELECT session_id, COUNT(*) AS depth
            FROM page_views
           WHERE created_at >= NOW() - INTERVAL '30 days'
             AND ${HUMAN}
             AND session_id IS NOT NULL
           GROUP BY session_id
        )
        SELECT COUNT(*) AS sessions,
               COUNT(*) FILTER (WHERE depth = 1) AS one_page,
               ROUND(AVG(depth), 2)::text AS avg_depth
          FROM s
      `),
      // Ошибки поведения: заходы на несуществующие адреса.
      pool.query<{ path: string; hits: string }>(`
        SELECT path, COUNT(*) AS hits
        FROM page_views
        WHERE created_at >= NOW() - INTERVAL '30 days'
          AND is_not_found
        GROUP BY path
        ORDER BY hits DESC
        LIMIT 10
      `),
    ]);

    const t = totals.rows[0];
    const cov = coverage.rows[0];
    const s = sessions.rows[0];
    return NextResponse.json({
      success: true,
      data: {
        totals: {
          today: { hits: Number(t.today_hits), uniques: Number(t.today_uniques) },
          week:  { hits: Number(t.week_hits),  visitorDays: Number(t.week_visitor_days) },
          month: { hits: Number(t.month_hits), visitorDays: Number(t.month_visitor_days) },
        },
        bots: { month_hits: Number(t.month_bot_hits) },
        daily: daily.rows.map(r => ({ day: r.day, hits: Number(r.hits), uniques: Number(r.uniques) })),
        top_paths: topPaths.rows.map(r => ({ path: r.path, hits: Number(r.hits) })),
        top_referrers: topReferrers.rows.map(r => ({ referrer: r.referrer, hits: Number(r.hits) })),
        edges: edges.rows.map(r => ({ from: r.from_path, to: r.to_path, hits: Number(r.hits) })),
        pages: pages.rows.map(r => ({
          path: r.path,
          views: Number(r.views),
          medianMs: r.median_ms == null ? null : Number(r.median_ms),
          exits: Number(r.exits),
        })),
        sessions: {
          total: Number(s?.sessions ?? 0),
          onePage: Number(s?.one_page ?? 0),
          avgDepth: s?.avg_depth == null ? null : Number(s.avg_depth),
        },
        not_found: notFound.rows.map(r => ({ path: r.path, hits: Number(r.hits) })),
        // Показываем подпись, только если есть строки БЕЗ хэша (значит уники
        // начались позже просмотров и раннее посчитать нельзя)
        uniques_since: cov?.has_unhashed ? (cov.uniques_since ?? null) : null,
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: safeMsg(error) }, { status: 500 });
  }
}
