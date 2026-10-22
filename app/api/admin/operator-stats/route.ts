import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import {
  OPERATOR_DATA_QUALITY_SQL, OPERATOR_INCOMPLETE_SQL,
  type OperatorDataQualityRow, type OperatorIncompleteRow,
} from '@/lib/admin/operator-stats-sql';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const [apps7, apps30, tours7, tours30, bookings7, bookings30, dataQuality, incomplete] = await Promise.all([
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

    // Заполненность — общим запросом (lib/admin/operator-stats-sql): contact —
    // jsonb, и сравнение с '' роняло роут на каждом вызове (22P02, #1428).
    pool.query<OperatorDataQualityRow>(OPERATOR_DATA_QUALITY_SQL),
    pool.query<OperatorIncompleteRow>(OPERATOR_INCOMPLETE_SQL),
  ]);

  const a7  = apps7.rows[0];
  const a30 = apps30.rows[0];
  const t7  = tours7.rows[0];
  const t30 = tours30.rows[0];
  const b7  = bookings7.rows[0];
  const b30 = bookings30.rows[0];
  const dq  = dataQuality.rows[0];

  const total           = Number(dq?.total ?? 0);
  const contactPct      = total > 0 ? Math.round(Number(dq?.contact_filled ?? 0)     / total * 100) : 0;
  const websitePct      = total > 0 ? Math.round(Number(dq?.website_filled ?? 0)     / total * 100) : 0;
  const descriptionPct  = total > 0 ? Math.round(Number(dq?.description_filled ?? 0) / total * 100) : 0;
  const qualityScore    = Math.round((contactPct + websitePct + descriptionPct) / 3);

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
    dataQuality: {
      total_operators:      total,
      contact_filled_pct:   contactPct,
      website_filled_pct:   websitePct,
      description_filled_pct: descriptionPct,
      quality_score:        qualityScore,
      incomplete_top10:     incomplete.rows.map(r => ({
        id:          r.id,
        name:        r.name,
        missing:     [
          ...(r.contact_missing     ? ['contact']     : []),
          ...(r.website_missing     ? ['website']     : []),
          ...(r.description_missing ? ['description'] : []),
        ],
      })),
    },
    as_of: new Date().toISOString(),
  });
}
