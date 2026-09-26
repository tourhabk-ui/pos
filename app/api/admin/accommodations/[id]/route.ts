/**
 * PATCH /api/admin/accommodations/[id] — решение по объекту жилья.
 *
 * action: 'approve' — объект выходит на витрину (если владелец его не
 *                     скрыл) и получает отметку «Проверено» (is_verified);
 *                     plannerZone (необязательно) — зона планера (миграция 1031);
 *         'set_zone' — только зона планера, без решения по объекту;
 *         'reject'  — снимается с витрины, причина обязательна и видна
 *                     владельцу в кабинете.
 *
 * Решение владельца 26.09: «объекты — в каталоге только после одобрения;
 * „Проверено“ ставит администратор». Это единственный писатель
 * moderation_status = approved/rejected и is_verified у жилья.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { logStayFailure } from '@/lib/stay/db-failure';
import { ZONE_IDS, ZONE_NAMES } from '@/lib/planner/constants';

export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ id: z.string().uuid('Некорректный ID объекта') });

const PlannerZoneSchema = z.enum(ZONE_IDS, { message: 'Зона планера: avachinsky, western, eastern или northern' });

const BodySchema = z.discriminatedUnion('action', [
  // Зона планера при одобрении необязательна: не передана — остаётся та,
  // что поставил владелец (или NULL, «не размечено»).
  z.object({ action: z.literal('approve'), plannerZone: PlannerZoneSchema.optional() }),
  z.object({
    action: z.literal('reject'),
    reason: z.string().trim()
      .min(5, 'Укажите причину отказа — владелец увидит её в кабинете')
      .max(1000, 'Причина длиннее 1000 символов'),
  }),
  // Разметка зоны без решения по объекту: у уже одобренных объектов (все,
  // заведённые до миграции 1031, — NULL). null — снять разметку.
  z.object({ action: z.literal('set_zone'), plannerZone: PlannerZoneSchema.nullable() }),
], { message: 'Действие: approve, reject или set_zone' });

const uuidSchema = z.string().uuid();

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authOrResponse = await requireAdmin(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const parsedParams = ParamsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ success: false, error: 'Некорректный ID объекта' }, { status: 400 });
  }
  const id = parsedParams.data.id;

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 }
    );
  }

  // Кто решил — только настоящий id пользователя (FK на users).
  const moderatedBy = uuidSchema.safeParse(authOrResponse.userId).success ? authOrResponse.userId : null;

  if (parsed.data.action === 'set_zone') {
    const zone = parsed.data.plannerZone;
    try {
      const { rows } = await pool.query<{ id: string; name: string; planner_zone: string | null }>(
        `UPDATE accommodations
            SET planner_zone = $2::varchar,
                updated_at   = NOW()
          WHERE id = $1::uuid
          RETURNING id, name, planner_zone`,
        [id, zone]
      );
      if (rows.length === 0) {
        return NextResponse.json({ success: false, error: 'Объект размещения не найден' }, { status: 404 });
      }
      return NextResponse.json({
        success: true,
        data: { id: rows[0].id, plannerZone: rows[0].planner_zone },
        message: zone
          ? `«${rows[0].name}»: зона планера — ${ZONE_NAMES[zone]}`
          : `«${rows[0].name}»: разметка зоны снята, планер объект не предлагает`,
      });
    } catch (error) {
      logStayFailure('PATCH /api/admin/accommodations/[id] set_zone', error);
      return NextResponse.json({ success: false, error: 'Не удалось сохранить зону' }, { status: 500 });
    }
  }

  const approve = parsed.data.action === 'approve';
  const reason = parsed.data.action === 'reject' ? parsed.data.reason : null;
  const zoneOnApprove = parsed.data.action === 'approve' ? (parsed.data.plannerZone ?? null) : null;

  try {
    const { rows } = await pool.query<{
      id: string; name: string; moderation_status: string; is_verified: boolean; is_active: boolean;
    }>(
      `UPDATE accommodations
          SET moderation_status = $2::varchar,
              moderation_reason = $3::text,
              is_verified       = $4::boolean,
              moderated_at      = NOW(),
              moderated_by      = $5::uuid,
              planner_zone      = COALESCE($6::varchar, planner_zone),
              updated_at        = NOW()
        WHERE id = $1::uuid
        RETURNING id, name, moderation_status, is_verified, is_active`,
      [id, approve ? 'approved' : 'rejected', reason, approve, moderatedBy, zoneOnApprove]
    );

    if (rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Объект размещения не найден' }, { status: 404 });
    }
    const row = rows[0];

    return NextResponse.json({
      success: true,
      data: {
        id: row.id,
        moderationStatus: row.moderation_status,
        isVerified: row.is_verified,
        isPublic: row.moderation_status === 'approved' && row.is_active,
      },
      message: approve
        ? (row.is_active
          ? `«${row.name}» одобрен и опубликован`
          : `«${row.name}» одобрен; на витрине появится, когда владелец включит показ`)
        : `«${row.name}» отклонён`,
    });
  } catch (error) {
    logStayFailure('PATCH /api/admin/accommodations/[id]', error);
    return NextResponse.json({ success: false, error: 'Не удалось сохранить решение' }, { status: 500 });
  }
}
