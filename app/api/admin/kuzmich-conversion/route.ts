/**
 * GET /api/admin/kuzmich-conversion
 *
 * Conversion analytics: Kuzmich conversations → bookings → revenue.
 * Answers the question "are AI agents generating revenue?"
 *
 * Data sources:
 *   - operator_bookings WHERE metadata->>'tg_chat_id' IS NOT NULL  → Kuzmich-originated
 *   - ai_actions_log WHERE action_type = 'agent_feedback'          → quality signal
 *
 * Auth: admin only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const authResult = await requireAdmin(req);
  if (authResult instanceof NextResponse) return authResult;

  const { searchParams } = new URL(req.url);
  const days = Math.min(parseInt(searchParams.get('days') ?? '30'), 365);

  const [bookingsRes, topToursRes, platformRes, feedbackRes, recentRes] = await Promise.all([
    // Overall conversion numbers
    pool.query<{
      total: string;
      kuzmich_total: string;
      kuzmich_confirmed: string;
      kuzmich_revenue: string;
      kuzmich_avg_check: string;
    }>(`
      SELECT
        COUNT(*)::text                                              AS total,
        COUNT(*) FILTER (WHERE metadata->>'tg_chat_id' IS NOT NULL)::text
                                                                   AS kuzmich_total,
        COUNT(*) FILTER (WHERE metadata->>'tg_chat_id' IS NOT NULL
                           AND booking_status NOT IN ('cancelled','rejected'))::text
                                                                   AS kuzmich_confirmed,
        COALESCE(SUM(final_price) FILTER (
          WHERE metadata->>'tg_chat_id' IS NOT NULL
            AND booking_status NOT IN ('cancelled','rejected')
        ), 0)::text                                                AS kuzmich_revenue,
        COALESCE(AVG(final_price) FILTER (
          WHERE metadata->>'tg_chat_id' IS NOT NULL
            AND booking_status NOT IN ('cancelled','rejected')
        ), 0)::text                                                AS kuzmich_avg_check
      FROM operator_bookings
      WHERE created_at > NOW() - ($1 || ' days')::interval
    `, [days]),

    // Top tours booked through Kuzmich
    pool.query<{ tour_id: string; title: string; cnt: string; revenue: string }>(`
      SELECT
        ob.operator_tour_id::text  AS tour_id,
        ot.title,
        COUNT(*)::text             AS cnt,
        COALESCE(SUM(ob.final_price), 0)::text AS revenue
      FROM operator_bookings ob
      JOIN operator_tours ot ON ot.id = ob.operator_tour_id
      WHERE ob.metadata->>'tg_chat_id' IS NOT NULL
        AND ob.booking_status NOT IN ('cancelled','rejected')
        AND ob.created_at > NOW() - ($1 || ' days')::interval
      GROUP BY ob.operator_tour_id, ot.title
      ORDER BY cnt::int DESC
      LIMIT 10
    `, [days]),

    // Breakdown by platform (tg vs max vs web)
    pool.query<{ platform: string; cnt: string; revenue: string }>(`
      SELECT
        COALESCE(metadata->>'platform', 'tg') AS platform,
        COUNT(*)::text                         AS cnt,
        COALESCE(SUM(final_price), 0)::text    AS revenue
      FROM operator_bookings
      WHERE metadata->>'tg_chat_id' IS NOT NULL
        AND booking_status NOT IN ('cancelled','rejected')
        AND created_at > NOW() - ($1 || ' days')::interval
      GROUP BY 1
      ORDER BY cnt::int DESC
    `, [days]),

    // Kuzmich feedback quality
    pool.query<{ rating: string; cnt: string }>(`
      SELECT
        metadata->>'rating'  AS rating,
        COUNT(*)::text        AS cnt
      FROM ai_actions_log
      WHERE action_type = 'agent_feedback'
        AND created_at > NOW() - ($1 || ' days')::interval
      GROUP BY 1
      ORDER BY cnt::int DESC
    `, [days]),

    // Recent Kuzmich bookings
    pool.query<{
      id: number; tour_title: string; tourist_name: string;
      final_price: string; booking_status: string;
      platform: string; created_at: Date;
    }>(`
      SELECT
        ob.id,
        ot.title              AS tour_title,
        ob.tourist_name,
        ob.final_price::text,
        ob.booking_status,
        COALESCE(ob.metadata->>'platform', 'tg') AS platform,
        ob.created_at
      FROM operator_bookings ob
      JOIN operator_tours ot ON ot.id = ob.operator_tour_id
      WHERE ob.metadata->>'tg_chat_id' IS NOT NULL
      ORDER BY ob.created_at DESC
      LIMIT 20
    `),
  ]);

  const s = bookingsRes.rows[0]!;
  const totalBookings = parseInt(s.total);
  const kuzmichTotal = parseInt(s.kuzmich_total);
  const kuzmichConfirmed = parseInt(s.kuzmich_confirmed);
  const kuzmichRevenue = parseFloat(s.kuzmich_revenue);

  const feedback = feedbackRes.rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.rating ?? 'unknown'] = parseInt(r.cnt);
    return acc;
  }, {});
  const totalFeedback = Object.values(feedback).reduce((a, b) => a + b, 0);
  const goodFeedback = feedback['good'] ?? 0;
  const satisfactionRate = totalFeedback > 0
    ? Math.round(goodFeedback / totalFeedback * 100)
    : null;

  return NextResponse.json({
    success: true,
    period_days: days,
    summary: {
      total_bookings: totalBookings,
      kuzmich_bookings: kuzmichTotal,
      kuzmich_confirmed: kuzmichConfirmed,
      kuzmich_share_pct: totalBookings > 0
        ? Math.round(kuzmichTotal / totalBookings * 100)
        : 0,
      kuzmich_revenue_rub: kuzmichRevenue,
      kuzmich_avg_check_rub: parseFloat(s.kuzmich_avg_check),
      satisfaction_rate_pct: satisfactionRate,
      feedback_total: totalFeedback,
    },
    top_tours: topToursRes.rows.map(r => ({
      tour_id: r.tour_id,
      title: r.title,
      bookings: parseInt(r.cnt),
      revenue: parseFloat(r.revenue),
    })),
    by_platform: platformRes.rows.map(r => ({
      platform: r.platform,
      bookings: parseInt(r.cnt),
      revenue: parseFloat(r.revenue),
    })),
    recent_bookings: recentRes.rows,
  });
}
