/**
 * GET /api/operator/analytics
 * Analytics data for operator: revenue, conversions, top tours
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { requireOperator } from '@/lib/auth/middleware';
import { ANALYTICS_SQL, logScreenQueryFailure } from '@/lib/operator/screen-queries';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const userOrResponse = await requireOperator(request);
  if (userOrResponse instanceof NextResponse) {
    return userOrResponse;
  }

  const userId = userOrResponse.userId;
  const { searchParams } = new URL(request.url);
  const periodDays = parseInt(searchParams.get('period') ?? '30', 10);

  try {
    // Resolve userId → partnerId (operator_tours.operator_id is partners.id)
    const partnerRes = await pool.query<{ id: string }>(
      `SELECT id FROM partners WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    const partnerId = partnerRes.rows[0]?.id;
    if (!partnerId) {
      return NextResponse.json({
        success: true,
        data: {
          period: { days: periodDays, start: '', end: '' },
          summary: { totalRevenue: 0, totalBookings: 0, avgBookingValue: 0, completedBookings: 0 },
          revenue: [],
          topTours: [],
          conversion: { pageViews: 0, bookings: 0, rate: 0 },
          statusBreakdown: {},
        },
      });
    }

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - periodDays);

    // 1. Revenue by month (through operator_tours for operator scoping)
    const { rows: revenueData } = await pool.query<{
      month: string;
      total_revenue: string;
      booking_count: string;
    }>(
      ANALYTICS_SQL.revenueByMonth,
      [partnerId, startDate.toISOString()]
    );

    // 2. Top tours by bookings
    const { rows: topTours } = await pool.query<{
      tour_id: string;
      tour_title: string;
      booking_count: string;
      total_revenue: string;
      avg_price: string;
    }>(
      ANALYTICS_SQL.topTours,
      [partnerId, startDate.toISOString()]
    );

    // 3. Conversion metrics (page_views → bookings)
    const { rows: conversionData } = await pool.query<{
      total_page_views: string;
      total_bookings: string;
      conversion_rate: string;
    }>(
      ANALYTICS_SQL.conversion,
      [partnerId, startDate.toISOString()]
    );

    // 4. Booking status breakdown
    const { rows: statusBreakdown } = await pool.query<{
      status: string;
      count: string;
    }>(
      ANALYTICS_SQL.statusBreakdown,
      [partnerId, startDate.toISOString()]
    );

    // 5. Summary metrics
    const { rows: summary } = await pool.query<{
      total_revenue: string;
      total_bookings: string;
      avg_booking_value: string;
      completed_bookings: string;
    }>(
      ANALYTICS_SQL.summary,
      [partnerId, startDate.toISOString()]
    );

    return NextResponse.json({
      success: true,
      data: {
        period: {
          days: periodDays,
          start: startDate.toISOString().split('T')[0],
          end: new Date().toISOString().split('T')[0],
        },
        summary: summary[0] ? {
          totalRevenue: Number(summary[0].total_revenue),
          totalBookings: Number(summary[0].total_bookings),
          avgBookingValue: Number(summary[0].avg_booking_value),
          completedBookings: Number(summary[0].completed_bookings),
        } : {
          totalRevenue: 0,
          totalBookings: 0,
          avgBookingValue: 0,
          completedBookings: 0,
        },
        revenue: revenueData.map(r => ({
          month: r.month,
          revenue: Number(r.total_revenue),
          bookings: Number(r.booking_count),
        })),
        topTours: topTours.map(t => ({
          id: t.tour_id,
          title: t.tour_title,
          bookings: Number(t.booking_count),
          revenue: Number(t.total_revenue),
          avgPrice: Number(t.avg_price),
        })),
        conversion: conversionData[0] ? {
          pageViews: Number(conversionData[0].total_page_views),
          bookings: Number(conversionData[0].total_bookings),
          rate: Number(conversionData[0].conversion_rate),
        } : {
          pageViews: 0,
          bookings: 0,
          rate: 0,
        },
        statusBreakdown: statusBreakdown.reduce((acc, row) => {
          acc[row.status] = Number(row.count);
          return acc;
        }, {} as Record<string, number>),
      },
    });
  } catch (error) {
    logScreenQueryFailure('analytics', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить аналитику. Попробуйте обновить страницу.' },
      { status: 500 }
    );
  }
}
