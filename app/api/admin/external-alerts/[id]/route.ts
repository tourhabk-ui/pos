import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireAdmin } from '@/lib/auth/middleware';
import { UTC_WALL_NOW_SQL } from '@/lib/db/timestamp-iso';
import { rejectParkReopening } from '@/lib/services/safety/park-reopening';

export const dynamic = 'force-dynamic';

const paramsSchema = z.object({ id: z.coerce.number().int().positive() });

/**
 * Основание существующего пункта (10.10). null в basisTitle — снять
 * основание. Вписанное человеком — manual: распознанное со снимка оно
 * заменяет, и экран перестаёт писать «распознано со снимка».
 */
const BasisSchema = z.object({
  basisTitle: z.string().trim().min(5, 'Основание — минимум 5 символов').max(400).nullable(),
  basisUrl: z.string().url().regex(/^https:\/\//, 'Ссылка на основание — только https').max(500).nullable().optional(),
}).strict();

/**
 * PATCH /api/admin/external-alerts/[id] — вписать или снять основание.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const adminOrResponse = await requireAdmin(request);
    if (adminOrResponse instanceof NextResponse) return adminOrResponse;

    const parsedParams = paramsSchema.safeParse(await params);
    if (!parsedParams.success) {
      return NextResponse.json({ success: false, error: 'Некорректный ID алерта' } as ApiResponse<null>, { status: 400 });
    }
    const body = BasisSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json(
        { success: false, error: body.error.issues[0]?.message || 'Некорректные данные' } as ApiResponse<null>,
        { status: 400 }
      );
    }
    const { basisTitle } = body.data;
    const basisUrl = basisTitle ? (body.data.basisUrl ?? null) : null;

    const result = await query(
      `UPDATE external_alerts
          SET basis_title = $2::text,
              basis_url = $3::text,
              basis_origin = CASE WHEN $2::text IS NULL THEN NULL ELSE 'manual' END,
              updated_at = ${UTC_WALL_NOW_SQL}
        WHERE id = $1
        RETURNING id`,
      [parsedParams.data.id, basisTitle, basisUrl]
    );
    if (result.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Алерт не найден' } as ApiResponse<null>, { status: 404 });
    }
    return NextResponse.json({
      success: true,
      message: basisTitle ? 'Основание записано.' : 'Основание снято.',
    } as ApiResponse<null>);
  } catch (error) {
    const code = (error as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error('[admin/external-alerts] основание не записано, SQLSTATE', code);
    return NextResponse.json({ success: false, error: 'Ошибка при записи основания' } as ApiResponse<null>, { status: 500 });
  }
}

/**
 * DELETE /api/admin/external-alerts/[id] - Погасить алерт.
 * Не удаляем строку, а гасим (expires_at = NOW()) — паттерн миграции 710:
 * история остаётся, дедуп по external_id продолжает работать.
 *
 * Гашение помечается `ended_by = 'admin'` (миграция 1394): истёкшее само
 * закрытие парка на межсезонье становится «статус не известен», а снятое
 * человеком — нет. Без метки их было не различить, и вывод «не знаю»
 * воскрешал бы снятое (lib/services/safety/park-reopening.ts). Снятая
 * строка «статус не известен» тем же правилом больше не выводится из того
 * же основания.
 *
 * Сводка об открытии парка (`park_reopening`) живой не бывает — она рождается
 * истёкшей, — и снять её прежним путём было нельзя. DELETE по её id её
 * ОТКЛОНЯЕТ: проходы парков её больше не читают, а закрытия, которые она
 * сузила или погасила, получают парки и срок обратно (rejectParkReopening,
 * ревью 06.11).
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

    const reopening = await rejectParkReopening(query, String(parsedParams.data.id));
    if (reopening.rejected) {
      return NextResponse.json({
        success: true,
        message: reopening.restored_ids.length > 0
          ? `Сводка об открытии отклонена. Закрытий возвращено: ${reopening.restored_ids.length}. Точки обновятся при ближайшем safety-ingest.`
          : 'Сводка об открытии отклонена. Закрытий она не меняла.',
      } as ApiResponse<null>);
    }

    const result = await query(
      `UPDATE external_alerts
       SET expires_at = ${UTC_WALL_NOW_SQL},
           ended_by = 'admin'
       WHERE id = $1 AND expires_at > ${UTC_WALL_NOW_SQL}
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
    // Отказ не глушится (§4.0): без строки в логе «не погасили» не найти.
    const code = (error as { code?: string })?.code ?? 'нет SQLSTATE';
    console.error('[admin/external-alerts] алерт не погашен, SQLSTATE', code);
    return NextResponse.json(
      { success: false, error: 'Ошибка при гашении алерта' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
