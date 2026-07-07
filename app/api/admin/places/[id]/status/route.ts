import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireAdmin } from '@/lib/auth/middleware';

export const dynamic = 'force-dynamic';

/**
 * PATCH /api/admin/places/[id]/status - Точечный оперативный статус места.
 *
 * Первый писатель is_open/alert_message в location_real_time_status:
 * поля существовали с миграции 0645, но заполнять их было нечем — зонные
 * алерты из safety-ingest пишут только active_alerts/alert_severity.
 * Здесь админ ставит точечное сообщение («проезд по пропускам, окна
 * 07-08/13-14/19-20») или закрывает место (is_open=false).
 */

const UpdateStatusSchema = z.object({
  isOpen: z.boolean().optional(),
  alertMessage: z.string().max(500, 'Сообщение — максимум 500 символов').nullable().optional(),
  alertExpiresAt: z.string().datetime({ offset: true, message: 'alertExpiresAt — ISO дата со смещением' }).nullable().optional(),
}).refine(d => d.isOpen !== undefined || d.alertMessage !== undefined || d.alertExpiresAt !== undefined, {
  message: 'Нет полей для обновления',
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const adminOrResponse = await requireAdmin(request);
    if (adminOrResponse instanceof NextResponse) return adminOrResponse;

    const { id } = await params;

    const body = await request.json();
    const parsed = UpdateStatusSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message || 'Некорректные данные' } as ApiResponse<null>,
        { status: 400 }
      );
    }

    // Карточка места принимает и places.id, и ark_id — здесь так же
    const placeResult = await query<{ ark_id: string; name: string }>(
      `SELECT ark_id, name FROM places WHERE ark_id::text = $1 OR id::text = $1 LIMIT 1`,
      [id]
    );
    if (placeResult.rows.length === 0 || !placeResult.rows[0].ark_id) {
      return NextResponse.json(
        { success: false, error: 'Место не найдено' } as ApiResponse<null>,
        { status: 404 }
      );
    }
    const arkId = placeResult.rows[0].ark_id;

    const { isOpen, alertMessage, alertExpiresAt } = parsed.data;

    // UPSERT: строка статуса могла не существовать (сид покрывал не все точки)
    const result = await query(
      `INSERT INTO location_real_time_status
         (agent_route_id, is_open, alert_message, alert_source, alert_expires_at, updated_at)
       VALUES ($1, COALESCE($2::boolean, TRUE), $3::varchar,
               CASE WHEN $3::varchar IS NOT NULL THEN 'manual' END, $4::timestamp, NOW())
       ON CONFLICT (agent_route_id) DO UPDATE SET
         is_open          = COALESCE($2::boolean, location_real_time_status.is_open),
         alert_message    = CASE WHEN $5::boolean THEN $3::varchar ELSE location_real_time_status.alert_message END,
         alert_source     = CASE WHEN $5::boolean AND $3::varchar IS NOT NULL THEN 'manual'
                                 WHEN $5::boolean AND $3::varchar IS NULL THEN NULL
                                 ELSE location_real_time_status.alert_source END,
         alert_expires_at = CASE WHEN $6::boolean THEN $4::timestamp ELSE location_real_time_status.alert_expires_at END,
         updated_at       = NOW()
       RETURNING agent_route_id, is_open, alert_message, alert_source, alert_expires_at`,
      [
        arkId,
        isOpen ?? null,
        alertMessage ?? null,
        alertExpiresAt ? new Date(alertExpiresAt) : null,
        alertMessage !== undefined,   // менять ли alert_message
        alertExpiresAt !== undefined, // менять ли alert_expires_at
      ]
    );

    return NextResponse.json({
      success: true,
      data: {
        place: placeResult.rows[0].name,
        status: result.rows[0],
      },
      message: 'Оперативный статус места обновлён'
    } as ApiResponse<unknown>);

  } catch (error) {
    return NextResponse.json(
      { success: false, error: 'Ошибка при обновлении статуса места' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
