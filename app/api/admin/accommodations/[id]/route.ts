/**
 * PATCH /api/admin/accommodations/[id] — решение по объекту жилья.
 *
 * action: 'approve' — объект выходит на витрину (если владелец его не
 *                     скрыл) и получает отметку «Проверено» (is_verified);
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

export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ id: z.string().uuid('Некорректный ID объекта') });

const BodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve') }),
  z.object({
    action: z.literal('reject'),
    reason: z.string().trim()
      .min(5, 'Укажите причину отказа — владелец увидит её в кабинете')
      .max(1000, 'Причина длиннее 1000 символов'),
  }),
], { message: 'Действие: approve или reject' });

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

  const approve = parsed.data.action === 'approve';
  const reason = parsed.data.action === 'reject' ? parsed.data.reason : null;

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
              updated_at        = NOW()
        WHERE id = $1::uuid
        RETURNING id, name, moderation_status, is_verified, is_active`,
      [id, approve ? 'approved' : 'rejected', reason, approve, moderatedBy]
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
