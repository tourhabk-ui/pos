/**
 * GET /api/hub/operator/earnings
 * Earnings summary for operator: direct bookings revenue + affiliate clicks
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const userOrResponse = await requireOperator(request);
  if (userOrResponse instanceof NextResponse) return userOrResponse;

  const operatorId = await getOperatorPartnerId(userOrResponse.userId);
  if (!operatorId) {
    return NextResponse.json({ error: 'Not an operator' }, { status: 403 });
  }

  // Revenue from operator_bookings in last 30 days grouped by day
  const bookingsResult = await pool.query(
    `SELECT
       COUNT(*) AS total_bookings,
       COALESCE(SUM(final_price), 0) AS total_revenue,
       COUNT(*) FILTER (WHERE booking_status = 'confirmed') AS confirmed_count,
       COUNT(*) FILTER (WHERE booking_status = 'new') AS pending_count,
       DATE(b.created_at) AS date
     FROM operator_bookings b
     JOIN operator_tours t ON b.operator_tour_id = t.id
     WHERE t.operator_id = $1
       AND b.deleted_at IS NULL
       AND b.created_at > NOW() - INTERVAL '30 days'
     GROUP BY DATE(b.created_at)
     ORDER BY date DESC`,
    [operatorId]
  );

  // Affiliate clicks (optional — table may not have data yet)
  const affiliateResult = await pool.query(
    `SELECT
       partner,
       COUNT(*) AS clicks,
       COUNT(DISTINCT ip_addr) AS unique_visitors
     FROM affiliate_clicks
     WHERE source = $1
       AND clicked_at > NOW() - INTERVAL '30 days'
     GROUP BY partner
     ORDER BY clicks DESC`,
    [`operator_page_${operatorId}`]
  ).catch(() => ({ rows: [] }));

  const totalBookings = bookingsResult.rows.reduce(
    (s, r) => s + parseInt(String(r.total_bookings), 10), 0
  );
  const totalRevenue = bookingsResult.rows.reduce(
    (s, r) => s + parseFloat(String(r.total_revenue)), 0
  );
  const confirmedBookings = bookingsResult.rows.reduce(
    (s, r) => s + parseInt(String(r.confirmed_count), 10), 0
  );
  const pendingBookings = bookingsResult.rows.reduce(
    (s, r) => s + parseInt(String(r.pending_count), 10), 0
  );
  const totalAffiliateClicks = affiliateResult.rows.reduce(
    (s, r) => s + parseInt(String(r.clicks), 10), 0
  );

  return NextResponse.json({
    success: true,
    summary: {
      totalBookings,
      totalRevenue,
      confirmedBookings,
      pendingBookings,
      affiliateClicks: totalAffiliateClicks,
      // Раньше здесь был totalAffiliateClicks * 50 — ставка «50 ₽ за клик»
      // не существует нигде: не в конфиге, не в договоре, не в БД. Оператор
      // видел это как реальную цифру дохода (аудит кабинета оператора,
      // §4.0: обязательное число не выдумывается при отсутствии источника).
      // Честно null — ставки партнёрских программ нет, значит и оценки нет.
      estimatedAffiliateCommission: null,
    },
    bookingsByDay: bookingsResult.rows,
    affiliatePartners: affiliateResult.rows,
  });
}
