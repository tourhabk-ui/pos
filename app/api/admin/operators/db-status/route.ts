import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const { rows } = await pool.query<{ total: string; with_website: string }>(`
      SELECT
        COUNT(*)::text                                           AS total,
        COUNT(*) FILTER (WHERE website IS NOT NULL AND website != '')::text AS with_website
      FROM partners
    `);
    const row = rows[0];
    return NextResponse.json({
      total: parseInt(row?.total ?? '0'),
      with_website: parseInt(row?.with_website ?? '0'),
    });
  } catch {
    return NextResponse.json({ total: 0, with_website: 0 });
  }
}
