import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireAdmin } from '@/lib/auth/middleware';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.coerce.number().int().positive() });

/**
 * DELETE /api/admin/external-alerts/[id] - Погасить алерт.
 * Не удаляем строку, а гасим (expires_at = NOW()) — паттерн миграции 710:
 * история остаётся, дедуп по external_id продолжает работать.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const adminOrResponse = await requireAdmin(request);
    if (adminOrResponse instanceof NextResponse) return adminOrResponse;

    const parsedParams = paramsSchema.safeParse(await params);
    if (!parsedParams.success) {
      return NextResponse.json(
        { success: false, error: 'Некорректный ID алерта' } as ApiResponse<null>,
        { status: 400 }
      );
    }

    const result = await query(
      `UPDATE external_alerts
       SET expires_at = NOW()
       WHERE id = $1 AND expires_at > NOW()
       RETURNING id`,
      [parsedParams.data.id]
    );

    if (result.rows.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Активный алерт не найден' } as ApiResponse<null>,
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Алерт погашен. Точки зоны обновятся при ближайшем safety-ingest.'
    } as ApiResponse<null>);

  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Ошибка при гашении алерта' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
