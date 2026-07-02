/**
 * GET /api/admin/places/merged
 *
 * Список уже объединённых дублей (merged_into_id IS NOT NULL) вместе с
 * названием канонической записи, в которую они слиты. Источник данных для
 * UI хард-удаления — DELETE /api/admin/places/[id] работает только с этими
 * записями.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

interface MergedRow {
  id: string;
  name: string;
  location_type: string | null;
  ark_id: string | null;
  merged_at: string | null;
  keep_id: string;
  keep_name: string;
  has_safety: boolean;
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') ?? '100', 10) || 100, 300);

  const result = await pool.query<MergedRow>(
    `SELECT
       p.id, p.name, p.location_type, p.ark_id, p.merged_at,
       keep.id AS keep_id, keep.name AS keep_name,
       (lsp.agent_route_id IS NOT NULL) AS has_safety
     FROM places p
     JOIN places keep ON keep.id = p.merged_into_id
     LEFT JOIN location_safety_profile lsp ON lsp.agent_route_id = p.ark_id
     WHERE p.merged_into_id IS NOT NULL
     ORDER BY p.merged_at DESC NULLS LAST
     LIMIT $1`,
    [limit],
  );

  return NextResponse.json({
    items: result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      locationType: r.location_type,
      arkId: r.ark_id,
      mergedAt: r.merged_at,
      keepId: r.keep_id,
      keepName: r.keep_name,
      hasSafetyProfile: r.has_safety,
    })),
  });
}
