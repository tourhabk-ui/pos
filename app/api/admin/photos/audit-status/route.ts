import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

interface AuditRow {
  image_id: string;
  place_name: string;
  location_type: string | null;
  ark_id: string;
  photo_verified: boolean | null;
  ai_audit_reason: string | null;
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const result = await pool.query<AuditRow>(
    `SELECT
       ari.id AS image_id,
       p.name AS place_name,
       p.location_type,
       p.ark_id,
       ari.photo_verified,
       ari.ai_audit_reason
     FROM ai_route_images ari
     JOIN places p ON p.ark_id = ari.route_id
     WHERE p.is_visible = true
     ORDER BY ari.photo_verified IS NOT NULL, ari.created_at DESC`,
  );

  const rows = result.rows;
  const total = rows.length;
  const verified = rows.filter((r) => r.photo_verified === true).length;
  const rejected = rows.filter((r) => r.photo_verified === false).length;
  const unreviewed = rows.filter((r) => r.photo_verified === null).length;

  return NextResponse.json({
    stats: { total, verified, rejected, unreviewed },
    photos: rows.map((r) => ({
      id: r.image_id,
      imageId: r.image_id,
      placeName: r.place_name,
      locationType: r.location_type,
      photoUrl: `/api/images/route/${r.ark_id}`,
      photoVerified: r.photo_verified,
      aiAuditReason: r.ai_audit_reason,
    })),
  });
}
