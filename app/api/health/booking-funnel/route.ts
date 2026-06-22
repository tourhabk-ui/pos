import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
});

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const parsed = QuerySchema.safeParse({
    days: req.nextUrl.searchParams.get('days') ?? 7,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'Некорректный параметр days (1–90)' }, { status: 400 });
  }
  const { days } = parsed.data;

  const [bookings, tours, operators] = await Promise.all([
    pool.query<{ status: string; count: string }>(
      `SELECT
         booking_status AS status,
         COUNT(*)::int  AS count
       FROM operator_bookings
       WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
       GROUP BY booking_status`,
      [days],
    ),
    pool.query<{ total: string; active: string }>(
      `SELECT
         COUNT(*)::int                                         AS total,
         COUNT(*) FILTER (WHERE is_active = true)::int        AS active
       FROM operator_tours`,
      [],
    ),
    pool.query<{ total: string }>(
      `SELECT COUNT(DISTINCT operator_id)::int AS total
       FROM operator_tours`,
      [],
    ),
  ]);

  const byStatus: Record<string, number> = {};
  for (const row of bookings.rows) {
    byStatus[row.status] = Number(row.count);
  }

  const totalBookings = Object.values(byStatus).reduce((s, n) => s + n, 0);
  const confirmedBookings = byStatus['confirmed'] ?? 0;

  return NextResponse.json({
    period_days: days,
    bookings: {
      total: totalBookings,
      by_status: byStatus,
    },
    tours: {
      total: Number(tours.rows[0]?.total ?? 0),
      active: Number(tours.rows[0]?.active ?? 0),
    },
    operators_with_tours: Number(operators.rows[0]?.total ?? 0),
    alert: confirmedBookings === 0,
    as_of: new Date().toISOString(),
  });
}
