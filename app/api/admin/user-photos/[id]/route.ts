import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { ApiResponse } from '@/types';
import { JWTPayload } from '@/lib/auth/jwt';

export const dynamic = 'force-dynamic';

const PatchSchema = z.object({
  action: z.enum(['approve', 'reject']),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const adminOrResponse = await requireAdmin(request);
    if (adminOrResponse instanceof NextResponse) return adminOrResponse;

    const admin = adminOrResponse as JWTPayload;
    const { id } = await params;

    const body: unknown = await request.json();
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.errors[0].message } satisfies ApiResponse<null>,
        { status: 400 }
      );
    }

    const newStatus = parsed.data.action === 'approve' ? 'approved' : 'rejected';

    const result = await pool.query(
      `UPDATE user_place_photos
         SET status = $1, reviewed_at = NOW(), reviewed_by = $2
       WHERE id = $3
       RETURNING id`,
      [newStatus, admin.userId, id]
    );

    if (result.rowCount === 0) {
      return NextResponse.json(
        { success: false, error: 'Фото не найдено' } satisfies ApiResponse<null>,
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true } satisfies ApiResponse<null>);
  } catch {
    return NextResponse.json(
      { success: false, error: 'Ошибка при обновлении статуса фото' } satisfies ApiResponse<null>,
      { status: 500 }
    );
  }
}
