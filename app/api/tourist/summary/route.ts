import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const auth = await requireAuth(req as never);
  if (auth instanceof NextResponse) return auth;
  const { userId, email } = auth;

  try {
    const [bookingsRes, ecoRes] = await Promise.all([
      pool.query<{ count: string; completed: string; total_spent: string }>(
        `SELECT
           COUNT(*)::text AS count,
           COUNT(*) FILTER (WHERE booking_status = 'completed')::text AS completed,
           COALESCE(SUM(CASE WHEN booking_status = 'completed' THEN final_price ELSE 0 END), 0)::text AS total_spent
         FROM operator_bookings
         WHERE tourist_email = $1 AND deleted_at IS NULL`,
        [email],
      ),
      pool.query<{ total_points: number; level: number; last_activity: string }>(
        `SELECT total_points, level, last_activity FROM user_eco_points WHERE user_id = $1`,
        [userId],
      ),
    ]);

    const bookings = bookingsRes.rows[0] ?? { count: '0', completed: '0', total_spent: '0' };
    const eco = ecoRes.rows[0] ?? { total_points: 0, level: 1, last_activity: null };

    return NextResponse.json({
      ok: true,
      data: {
        bookings_count: parseInt(bookings.count),
        bookings_completed: parseInt(bookings.completed),
        total_spent: parseFloat(bookings.total_spent),
        eco_points: eco.total_points,
        eco_level: eco.level,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
