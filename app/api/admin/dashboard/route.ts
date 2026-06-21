import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import {
  DashboardMetricsRow, TopTourRow, ActivityRow,
} from '@/lib/types/db-rows';

export const dynamic = 'force-dynamic';

function calcTrend(current: number, previous: number): { change: number; trend: 'up' | 'down' | 'neutral' } {
  if (previous === 0) return { change: 0, trend: 'neutral' };
  const change = Math.round(((current - previous) / previous) * 1000) / 10;
  return { change, trend: change > 0 ? 'up' : change < 0 ? 'down' : 'neutral' };
}

export async function GET(request: NextRequest) {
  try {
    const adminOrResponse = await requireAdmin(request);
    if (adminOrResponse instanceof NextResponse) return adminOrResponse;

    const period = Math.min(
      Math.max(parseInt(request.nextUrl.searchParams.get('period') ?? '30', 10), 7),
      90,
    );

    const [metrics, topTours, recentActivity, pending] = await Promise.all([
      pool.query<DashboardMetricsRow>(`
        WITH current_period AS (
          SELECT
            COUNT(*) FILTER (WHERE created_at >= NOW() - ($1::int || ' days')::INTERVAL) AS current_bookings,
            COUNT(*) FILTER (WHERE created_at >= NOW() - ($1::int * 2 || ' days')::INTERVAL
                               AND created_at <  NOW() - ($1::int || ' days')::INTERVAL) AS previous_bookings,
            COALESCE(SUM(COALESCE(final_price, base_total_price))
              FILTER (WHERE created_at >= NOW() - ($1::int || ' days')::INTERVAL AND booking_status = 'confirmed'), 0) AS current_revenue,
            COALESCE(SUM(COALESCE(final_price, base_total_price))
              FILTER (WHERE created_at >= NOW() - ($1::int * 2 || ' days')::INTERVAL
                       AND created_at <  NOW() - ($1::int || ' days')::INTERVAL AND booking_status = 'confirmed'), 0) AS previous_revenue
          FROM operator_bookings
        ),
        user_stats AS (
          SELECT
            COUNT(*) FILTER (WHERE created_at >= NOW() - ($1::int || ' days')::INTERVAL) AS current_users,
            COUNT(*) FILTER (WHERE created_at >= NOW() - ($1::int * 2 || ' days')::INTERVAL
                               AND created_at <  NOW() - ($1::int || ' days')::INTERVAL) AS previous_users,
            COUNT(*) AS total_users
          FROM users
        ),
        conversion AS (
          SELECT COUNT(DISTINCT u.id) AS users_with_bookings
          FROM users u
          WHERE EXISTS (SELECT 1 FROM operator_bookings b WHERE b.metadata->>'user_id' = u.id::text)
        )
        SELECT
          cp.current_bookings, cp.previous_bookings,
          cp.current_revenue,  cp.previous_revenue,
          us.current_users,    us.previous_users, us.total_users,
          cv.users_with_bookings,
          CASE WHEN us.total_users > 0
            THEN ROUND((cv.users_with_bookings::numeric / us.total_users) * 100, 2)
            ELSE 0
          END AS conversion_rate
        FROM current_period cp, user_stats us, conversion cv
      `, [period]),

      pool.query<TopTourRow>(`
        SELECT
          t.id, t.title,
          COUNT(b.id)::int AS bookings,
          COALESCE(SUM(COALESCE(b.final_price, b.base_total_price))
            FILTER (WHERE b.booking_status = 'confirmed'), 0) AS revenue
        FROM operator_tours t
        LEFT JOIN operator_bookings b ON b.operator_tour_id = t.id
          AND b.created_at >= NOW() - ($1::int || ' days')::INTERVAL
        GROUP BY t.id, t.title
        ORDER BY bookings DESC
        LIMIT 5
      `, [period]),

      pool.query<ActivityRow>(`
        SELECT
          b.id,
          'booking' AS type,
          'New booking' AS title,
          CONCAT('Бронирование: ', t.title) AS description,
          b.created_at::text AS timestamp
        FROM operator_bookings b
        JOIN operator_tours t ON t.id = b.operator_tour_id
        ORDER BY b.created_at DESC
        LIMIT 10
      `),

      pool.query<{ pending_tours: string; pending_partners: string }>(`
        SELECT
          COUNT(*) FILTER (WHERE is_active = false AND created_at > NOW() - INTERVAL '30 days')::text AS pending_tours
        FROM operator_tours
      `).then(async r => {
        const pt = parseInt(r.rows[0]?.pending_tours ?? '0', 10);
        const pp = await pool.query<{ c: string }>(`
          SELECT COUNT(*)::text AS c FROM partners WHERE is_verified = false AND is_public = false
        `);
        return { pendingTours: pt, pendingPartners: parseInt(pp.rows[0]?.c ?? '0', 10) };
      }),
    ]);

    const m = metrics.rows[0];
    const curBookings  = parseInt(m?.current_bookings  ?? '0', 10);
    const prevBookings = parseInt(m?.previous_bookings ?? '0', 10);
    const curRevenue   = parseFloat(m?.current_revenue  ?? '0');
    const prevRevenue  = parseFloat(m?.previous_revenue ?? '0');
    const curUsers     = parseInt(m?.current_users     ?? '0', 10);
    const prevUsers    = parseInt(m?.previous_users    ?? '0', 10);
    const convRate     = parseFloat(m?.conversion_rate ?? '0');

    return NextResponse.json({
      success: true,
      data: {
        metrics: {
          totalRevenue:   { value: curRevenue,  ...calcTrend(curRevenue,  prevRevenue)  },
          totalBookings:  { value: curBookings, ...calcTrend(curBookings, prevBookings) },
          activeUsers:    { value: curUsers,    ...calcTrend(curUsers,    prevUsers)    },
          conversionRate: { value: convRate, change: 0, trend: 'neutral' as const },
        },
        charts: {
          topTours: topTours.rows.map(t => ({
            id: t.id,
            title: t.title,
            bookings: typeof t.bookings === 'number' ? t.bookings : parseInt(t.bookings as unknown as string, 10),
            revenue: parseFloat(t.revenue as unknown as string),
          })),
        },
        recentActivities: recentActivity.rows.map(r => ({
          id: r.id,
          type: r.type,
          title: r.title,
          description: r.description,
          timestamp: r.timestamp,
        })),
        pendingTours: pending.pendingTours,
        pendingPartners: pending.pendingPartners,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Ошибка при получении дашборда', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
