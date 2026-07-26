/**
 * GET /api/admin/analytics/traffic — посещаемость из первичного счётчика
 * (page_views: PageViewTracker -> /api/analytics/hit).
 *
 * «Уникальные» — по суточному visitor_hash (сырые IP не хранятся, 152-ФЗ);
 * у старых строк без хэша уникальность посчитать нельзя — честно считаем
 * только по строкам, где хэш есть.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { safeMsg } from '@/lib/errors/sanitize';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const [totals, daily, topPaths, topReferrers] = await Promise.all([
      pool.query<{
        today_hits: string; today_uniques: string;
        week_hits: string; week_uniques: string;
        month_hits: string; month_uniques: string;
      }>(`
        SELECT
          COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE) AS today_hits,
          COUNT(DISTINCT visitor_hash) FILTER (WHERE created_at >= CURRENT_DATE AND visitor_hash IS NOT NULL) AS today_uniques,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS week_hits,
          COUNT(DISTINCT visitor_hash) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days' AND visitor_hash IS NOT NULL) AS week_uniques,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS month_hits,
          COUNT(DISTINCT visitor_hash) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days' AND visitor_hash IS NOT NULL) AS month_uniques
        FROM page_views
      `),
      pool.query<{ day: string; hits: string; uniques: string }>(`
        SELECT
          to_char(created_at::date, 'YYYY-MM-DD') AS day,
          COUNT(*) AS hits,
          COUNT(DISTINCT visitor_hash) FILTER (WHERE visitor_hash IS NOT NULL) AS uniques
        FROM page_views
        WHERE created_at >= NOW() - INTERVAL '14 days'
        GROUP BY created_at::date
        ORDER BY created_at::date DESC
      `),
      pool.query<{ path: string; hits: string }>(`
        SELECT path, COUNT(*) AS hits
        FROM page_views
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY path
        ORDER BY hits DESC
        LIMIT 15
      `),
      pool.query<{ referrer: string; hits: string }>(`
        SELECT referrer, COUNT(*) AS hits
        FROM page_views
        WHERE created_at >= NOW() - INTERVAL '30 days'
          AND referrer IS NOT NULL
          AND referrer !~* 'vedarai\\.ru'
        GROUP BY referrer
        ORDER BY hits DESC
        LIMIT 10
      `),
    ]);

    const t = totals.rows[0];
    return NextResponse.json({
      success: true,
      data: {
        totals: {
          today:  { hits: Number(t.today_hits),  uniques: Number(t.today_uniques) },
          week:   { hits: Number(t.week_hits),   uniques: Number(t.week_uniques) },
          month:  { hits: Number(t.month_hits),  uniques: Number(t.month_uniques) },
        },
        daily: daily.rows.map(r => ({ day: r.day, hits: Number(r.hits), uniques: Number(r.uniques) })),
        top_paths: topPaths.rows.map(r => ({ path: r.path, hits: Number(r.hits) })),
        top_referrers: topReferrers.rows.map(r => ({ referrer: r.referrer, hits: Number(r.hits) })),
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: safeMsg(error) }, { status: 500 });
  }
}
