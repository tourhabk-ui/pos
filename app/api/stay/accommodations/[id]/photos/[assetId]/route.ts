import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { requireAccommodationAccess } from '@/lib/auth/stay-helpers';
import { logStayFailure } from '@/lib/stay/db-failure';

export const dynamic = 'force-dynamic';

/**
 * DELETE /api/stay/accommodations/[id]/photos/[assetId] — отвязать фото
 * от объекта. Сама строка assets не удаляется: ассеты дедуплицируются
 * по sha256 и могут быть привязаны к другим сущностям.
 */
export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string; assetId: string }> }
) {
  const { id, assetId } = await context.params;
  if (!z.string().uuid().safeParse(assetId).success) {
    return NextResponse.json({ success: false, error: 'Некорректный id фотографии' }, { status: 400 });
  }

  const authOrResponse = await requireAccommodationAccess(request, id);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM accommodation_assets
       WHERE accommodation_id = $1 AND asset_id = $2`,
      [id, assetId]
    );

    if ((rowCount ?? 0) === 0) {
      return NextResponse.json({ success: false, error: 'Фотография не найдена у этого объекта' }, { status: 404 });
    }

    return NextResponse.json({ success: true, message: 'Фотография удалена' });
  } catch (error) {
    logStayFailure('DELETE /api/stay/accommodations/[id]/photos/[assetId]', error);
    return NextResponse.json({ success: false, error: 'Ошибка при удалении фотографии' }, { status: 500 });
  }
}
