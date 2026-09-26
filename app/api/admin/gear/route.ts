/**
 * GET /api/admin/gear — позиции проката для проверки администратором.
 *
 * Решение владельца 26.09: «как у жилья: модерация админом». Порядок ответа
 * тот же, что у объектов жилья: сначала ждущие решения, потом остальные.
 *
 * `moderated_at IS NULL` у одобренной позиции значит «одобрена до введения
 * проверки» (миграция 1030), а не «решение принято неизвестно когда»: до
 * 26.09 заведение позиции и было публикацией. Такие видны отдельной меткой —
 * администратору важно отличать своё решение от унаследованного.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { MODERATION_STATUSES } from '@/lib/gear/moderation';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  status: z.enum(MODERATION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export async function GET(request: NextRequest) {
  const authOrResponse = await requireAdmin(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    status: url.searchParams.get('status') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные параметры' },
      { status: 400 },
    );
  }

  const { status, limit } = parsed.data;
  const params: Array<string | number> = [limit];
  const where = status ? 'WHERE gi.moderation_status = $2::varchar' : '';
  if (status) params.push(status);

  try {
    const { rows } = await pool.query(
      `SELECT gi.id, gi.name, gi.category, gi.price_per_day, gi.images,
              gi.is_active, gi.moderation_status, gi.moderation_reason,
              gi.moderated_at, gi.created_at,
              p.id AS partner_id, p.name AS partner_name, p.is_verified AS partner_verified
         FROM gear_items gi
         JOIN partners p ON p.id = gi.partner_id
         ${where}
        ORDER BY CASE gi.moderation_status WHEN 'pending' THEN 0 ELSE 1 END,
                 gi.created_at DESC
        LIMIT $1::int`,
      params,
    );
    return NextResponse.json({ success: true, data: rows });
  } catch (error) {
    console.error('[admin/gear] список не прочитан:',
      error instanceof Error ? error.message : error);
    return NextResponse.json({ success: false, error: 'Не удалось прочитать позиции' }, { status: 503 });
  }
}
