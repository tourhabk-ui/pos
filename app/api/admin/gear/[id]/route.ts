/**
 * PATCH /api/admin/gear/[id] — решение по позиции проката.
 *
 * action: 'approve' — позиция выходит в каталог (если партнёр её не снял);
 *         'reject'  — снимается, причина обязательна и видна партнёру.
 *
 * Решение владельца 26.09: «как у жилья: модерация админом». Это единственный
 * писатель `moderation_status` = approved/rejected у позиций проката.
 *
 * Отметку «Проверено» партнёру здесь НЕ ставим, в отличие от жилья: у жилья
 * своя колонка `accommodations.is_verified` — про объект, а у проката
 * `partners.is_verified` — про партнёра целиком. Одобрение одной позиции не
 * означает проверки партнёра, и подменять одно другим значило бы выдать
 * непроверенного за проверенного (§4.0).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ id: z.string().uuid('Некорректный ID позиции') });

const BodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve') }),
  z.object({
    action: z.literal('reject'),
    reason: z.string().trim()
      .min(5, 'Укажите причину отказа — партнёр увидит её в кабинете')
      .max(1000, 'Причина длиннее 1000 символов'),
  }),
], { message: 'Действие: approve или reject' });

const uuidSchema = z.string().uuid();

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authOrResponse = await requireAdmin(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const parsedParams = ParamsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ success: false, error: 'Некорректный ID позиции' }, { status: 400 });
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
      { status: 400 },
    );
  }

  // Кто решил — только настоящий id пользователя (FK на users).
  const moderatedBy = uuidSchema.safeParse(authOrResponse.userId).success ? authOrResponse.userId : null;

  const approve = parsed.data.action === 'approve';
  const reason = parsed.data.action === 'reject' ? parsed.data.reason : null;

  try {
    const { rows } = await pool.query<{
      id: string; name: string; moderation_status: string; is_active: boolean;
    }>(
      `UPDATE gear_items
          SET moderation_status = $2::varchar,
              moderation_reason = $3::text,
              moderated_at      = NOW(),
              moderated_by      = $4::uuid,
              updated_at        = NOW()
        WHERE id = $1::uuid
        RETURNING id, name, moderation_status, is_active`,
      [id, approve ? 'approved' : 'rejected', reason, moderatedBy],
    );

    if (rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Позиция проката не найдена' }, { status: 404 });
    }
    const row = rows[0];

    return NextResponse.json({
      success: true,
      data: {
        id: row.id,
        moderationStatus: row.moderation_status,
        isPublic: row.moderation_status === 'approved' && row.is_active,
      },
      message: approve
        ? (row.is_active
          ? `«${row.name}» одобрена и в каталоге`
          : `«${row.name}» одобрена; в каталоге появится, когда партнёр включит показ`)
        : `«${row.name}» отклонена`,
    });
  } catch (error) {
    console.error('[admin/gear/[id]] решение не сохранено:',
      error instanceof Error ? error.message : error);
    return NextResponse.json({ success: false, error: 'Не удалось сохранить решение' }, { status: 500 });
  }
}
