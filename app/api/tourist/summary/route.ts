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
      // Реестр эко — единственный источник. Раньше здесь читалась таблица
      // user_eco_points, которую не создаёт ни одна миграция (она есть только
      // в неприменяемом lib/database/schema.sql). Запрос стоял в Promise.all,
      // поэтому падал ВЕСЬ ответ: /my-kamchatka не получал даже число броней.
      pool.query<{ utility: string; contribution: string }>(
        `SELECT
           COALESCE(MAX(balance) FILTER (WHERE account = $1), 0)::text AS utility,
           COALESCE(MAX(balance) FILTER (WHERE account = $2), 0)::text AS contribution
         FROM eco_balances
         WHERE account IN ($1, $2)`,
        [`user:${userId}`, `contrib:${userId}`],
      ),
    ]);

    const bookings = bookingsRes.rows[0] ?? { count: '0', completed: '0', total_spent: '0' };
    const eco = ecoRes.rows[0] ?? { utility: '0', contribution: '0' };

    return NextResponse.json({
      ok: true,
      data: {
        bookings_count: parseInt(bookings.count),
        bookings_completed: parseInt(bookings.completed),
        total_spent: parseFloat(bookings.total_spent),
        // Два слоя раздельно (docs/ECO.md): вклад не тратится, польза тратится.
        eco_utility: Number(eco.utility),
        eco_contribution: Number(eco.contribution),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
