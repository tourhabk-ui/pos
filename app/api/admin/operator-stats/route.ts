import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const [apps7, apps30, tours7, tours30, bookings7, bookings30] = await Promise.all([
    pool.query<{ total: string; approved: string }>(
      `SELECT
         COUNT(*)::int                                              AS total,
         COUNT(*) FILTER (WHERE status = 'approved')::int          AS approved
       FROM operator_applications
       WHERE created_at >= NOW() - INTERVAL '7 days'`,
      [],
    ),

    pool.query<{ total: string; approved: string }>(
      `SELECT
         COUNT(*)::int                                              AS total,
         COUNT(*) FILTER (WHERE status = 'approved')::int          AS approved
       FROM operator_applications
       WHERE created_at >= NOW() - INTERVAL '30 days'`,
      [],
    ),

    pool.query<{ total: string; active: string }>(
      `SELECT
         COUNT(*)::int                                         AS total,
         COUNT(*) FILTER (WHERE is_active = true)::int        AS active
       FROM operator_tours
       WHERE created_at >= NOW() - INTERVAL '7 days'`,
      [],
    ),

    pool.query<{ total: string; active: string }>(
      `SELECT
         COUNT(*)::int                                         AS total,
         COUNT(*) FILTER (WHERE is_active = true)::int        AS active
       FROM operator_tours
       WHERE created_at >= NOW() - INTERVAL '30 days'`,
      [],
    ),

    pool.query<{ total: string; confirmed: string }>(
      `SELECT
         COUNT(*)::int                                                       AS total,
         COUNT(*) FILTER (WHERE booking_status = 'confirmed')::int          AS confirmed
       FROM operator_bookings
       WHERE created_at >= NOW() - INTERVAL '7 days'`,
      [],
    ),

    pool.query<{ total: string; confirmed: string }>(
      `SELECT
         COUNT(*)::int                                                       AS total,
         COUNT(*) FILTER (WHERE booking_status = 'confirmed')::int          AS confirmed
       FROM operator_bookings
       WHERE created_at >= NOW() - INTERVAL '30 days'`,
      [],
    ),
  ]);

  const a7  = apps7.rows[0];
  const a30 = apps30.rows[0];
  const t7  = tours7.rows[0];
  const t30 = tours30.rows[0];
  const b7  = bookings7.rows[0];
  const b30 = bookings30.rows[0];

  return NextResponse.json({
    operator_applications: {
      last_7d:  { total: Number(a7?.total ?? 0),  approved: Number(a7?.approved ?? 0) },
      last_30d: { total: Number(a30?.total ?? 0), approved: Number(a30?.approved ?? 0) },
    },
    operator_tours: {
      last_7d:  { total: Number(t7?.total ?? 0),  active: Number(t7?.active ?? 0) },
      last_30d: { total: Number(t30?.total ?? 0), active: Number(t30?.active ?? 0) },
    },
    operator_bookings: {
      last_7d:  { total: Number(b7?.total ?? 0),  confirmed: Number(b7?.confirmed ?? 0) },
      last_30d: { total: Number(b30?.total ?? 0), confirmed: Number(b30?.confirmed ?? 0) },
    },
    as_of: new Date().toISOString(),
  });
}
