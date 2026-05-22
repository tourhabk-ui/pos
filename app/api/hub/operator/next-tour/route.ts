/**
 * GET /api/hub/operator/next-tour
 * Returns the nearest upcoming tour date that has active bookings.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/middleware';
import { query } from '@/lib/database';

export const dynamic = 'force-dynamic';

async function getOperatorId(userId: string): Promise<string | null> {
  const res = await query(
    `SELECT id FROM partners WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  return (res.rows[0]?.id as string) ?? null;
}

export async function GET(request: NextRequest) {
  try {
    const authOrResponse = await requireOperator(request);
    if (authOrResponse instanceof NextResponse) return authOrResponse;

    const operatorId = await getOperatorId(authOrResponse.userId);
    if (!operatorId) {
      return NextResponse.json({ error: 'Not an operator' }, { status: 403 });
    }

    // Find the nearest date with active bookings across all tours of this operator
    const summaryRes = await query(
      `SELECT
         t.id          AS tour_id,
         t.title       AS tour_title,
         b.booking_date,
         (b.booking_date - CURRENT_DATE)::int AS days_until,
         COUNT(b.id)::int                     AS booking_count,
         SUM(b.participants)::int             AS total_participants
       FROM operator_bookings b
       JOIN operator_tours t ON b.operator_tour_id = t.id
       WHERE t.operator_id = $1
         AND b.booking_date >= CURRENT_DATE
         AND b.booking_status IN ('new', 'confirmed')
         AND b.deleted_at IS NULL
       GROUP BY t.id, t.title, b.booking_date
       ORDER BY b.booking_date ASC
       LIMIT 1`,
      [operatorId]
    );

    if (summaryRes.rows.length === 0) {
      return NextResponse.json({ success: true, next_tour: null });
    }

    const summary = summaryRes.rows[0];

    // Fetch individual bookings for that specific date+tour
    const bookingsRes = await query(
      `SELECT
         b.id,
         b.tourist_name,
         b.tourist_phone,
         b.participants,
         b.booking_status,
         b.final_price
       FROM operator_bookings b
       WHERE b.operator_tour_id = $1
         AND b.booking_date = $2
         AND b.booking_status IN ('new', 'confirmed')
         AND b.deleted_at IS NULL
       ORDER BY b.created_at ASC
       LIMIT 10`,
      [summary.tour_id, summary.booking_date]
    );

    return NextResponse.json({
      success: true,
      next_tour: {
        tour_id: String(summary.tour_id),
        tour_title: summary.tour_title,
        booking_date: summary.booking_date,
        days_until: Number(summary.days_until),
        booking_count: Number(summary.booking_count),
        total_participants: Number(summary.total_participants),
        bookings: bookingsRes.rows.map(b => ({
          id: String(b.id),
          tourist_name: b.tourist_name as string | null,
          tourist_phone: b.tourist_phone as string | null,
          participants: Number(b.participants),
          booking_status: b.booking_status as string,
          final_price: b.final_price !== null ? Number(b.final_price) : null,
        })),
      },
    });
  } catch {
    return NextResponse.json({ error: 'Failed to fetch next tour' }, { status: 500 });
  }
}
