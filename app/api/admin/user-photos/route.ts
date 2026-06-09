import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { ApiResponse } from '@/types';
import { UserPlacePhotoAdminRow } from '@/lib/types/db-rows';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const adminOrResponse = await requireAdmin(request);
    if (adminOrResponse instanceof NextResponse) return adminOrResponse;

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status') ?? 'pending';

    const validStatuses = ['pending', 'approved', 'rejected'];
    const safeStatus = validStatuses.includes(status) ? status : 'pending';

    const result = await pool.query<UserPlacePhotoAdminRow>(
      `SELECT
         p.id,
         p.place_id,
         pl.name AS place_name,
         p.user_id,
         u.email AS user_email,
         u.name  AS user_name,
         p.url,
         p.caption,
         p.status,
         p.created_at,
         p.reviewed_at
       FROM user_place_photos p
       LEFT JOIN places pl ON pl.id = p.place_id
       LEFT JOIN users  u  ON u.id  = p.user_id
       WHERE p.status = $1
       ORDER BY p.created_at DESC
       LIMIT 100`,
      [safeStatus]
    );

    const data = result.rows.map((row) => ({
      id: row.id,
      placeId: row.place_id,
      placeName: row.place_name ?? '',
      userId: row.user_id ?? null,
      userEmail: row.user_email ?? null,
      userName: row.user_name ?? null,
      url: row.url,
      caption: row.caption ?? null,
      status: row.status,
      createdAt: row.created_at,
    }));

    return NextResponse.json({ success: true, data } satisfies ApiResponse<typeof data>);
  } catch {
    return NextResponse.json(
      { success: false, error: 'Ошибка при получении фото туристов' } satisfies ApiResponse<null>,
      { status: 500 }
    );
  }
}
