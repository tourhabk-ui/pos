import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  const [stats, fresh] = await Promise.all([
    pool.query<{ total: string; oldest_age_hours: string | null }>(
      `SELECT
         COUNT(*)::int                                                       AS total,
         EXTRACT(EPOCH FROM (NOW() - MIN(generated_at))) / 3600.0           AS oldest_age_hours
       FROM route_description_cache`,
      [],
    ),
    pool.query<{ fresh_24h: string }>(
      `SELECT COUNT(*)::int AS fresh_24h
       FROM route_description_cache
       WHERE generated_at >= NOW() - INTERVAL '24 hours'`,
      [],
    ),
  ]);

  const row = stats.rows[0];
  const total = Number(row?.total ?? 0);

  return NextResponse.json({
    total_entries: total,
    fresh_entries_24h: Number(fresh.rows[0]?.fresh_24h ?? 0),
    oldest_entry_age_hours: total > 0 && row?.oldest_age_hours != null
      ? Math.round(Number(row.oldest_age_hours))
      : null,
    as_of: new Date().toISOString(),
  });
}
