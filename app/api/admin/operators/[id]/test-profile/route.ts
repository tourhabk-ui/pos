/**
 * PATCH /api/admin/operators/[id]/test-profile
 * Отметить партнёра тестовым: витрина его не показывает.
 * Снять отметку — вернуть на витрину. Только администратор.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { query } from '@/lib/database';
import { sqlState } from '@/lib/guides/db-failure';

export const dynamic = 'force-dynamic';

const Body = z.object({
  is_test: z.boolean(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authOrResponse = await requireAdmin(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ error: 'Некорректный идентификатор партнёра' }, { status: 400 });
  }

  const body: unknown = await request.json().catch(() => null);
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Укажите, тестовый профиль или нет' }, { status: 400 });
  }

  try {
    const result = await query<{ id: string; is_test: boolean; name: string }>(
      `UPDATE partners
          SET is_test = $2
        WHERE id = $1::uuid
        RETURNING id::text AS id, is_test, name`,
      [id, parsed.data.is_test],
    );
    const row = result.rows[0];
    if (!row) {
      return NextResponse.json({ error: 'Партнёр не найден' }, { status: 404 });
    }
    return NextResponse.json({
      success: true,
      data: { id: row.id, is_test: row.is_test === true, name: row.name },
    });
  } catch (err) {
    console.error(
      '[admin/operators/test-profile] отметка не записана, SQLSTATE',
      sqlState(err),
      err instanceof Error ? err.message : err,
    );
    return NextResponse.json({ error: 'Не удалось сохранить отметку' }, { status: 500 });
  }
}
