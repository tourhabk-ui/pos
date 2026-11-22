/**
 * PATCH /api/admin/operators/[id]/test-profile — отметка «тестовый профиль»
 * (миграция 1495, lib/partners/test-profile.ts). Только администратор.
 *
 * Отметить — карточка уходит с витрины тем же запросом (`is_public = FALSE`):
 * тестовый профиль на витрине база не держит (CHECK partners_test_not_public),
 * туры тестового партнёра не пускает шлюз витрины.
 *
 * Снять — на витрину карточка сама не возвращается: вернуть её — отдельное
 * решение администратора (одобрение или правка карточки). Ответ это называет,
 * чтобы «снял отметку» не читалось как «компания снова видна».
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { query } from '@/lib/database';
import { sqlState } from '@/lib/guides/db-failure';
import { TEST_PROFILE_MARKED_TEXT, TEST_PROFILE_UNMARKED_TEXT } from '@/lib/partners/test-profile';

export const dynamic = 'force-dynamic';

const Body = z.object({ is_test: z.boolean() });

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authOrResponse = await requireAdmin(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ success: false, error: 'Некорректный идентификатор партнёра' }, { status: 400 });
  }

  const body: unknown = await request.json().catch(() => null);
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Укажите is_test: true или false' }, { status: 400 });
  }
  const isTest = parsed.data.is_test;

  try {
    const result = await query<{ id: string; is_test: boolean; is_public: boolean | null }>(
      `UPDATE partners
          SET is_test = $2,
              is_public = CASE WHEN $2 THEN FALSE ELSE is_public END,
              updated_at = NOW()
        WHERE id = $1::uuid
        RETURNING id::text AS id, is_test, is_public`,
      [id, isTest],
    );
    const row = result.rows[0];
    if (!row) {
      return NextResponse.json({ success: false, error: 'Партнёр не найден' }, { status: 404 });
    }
    return NextResponse.json({
      success: true,
      data: { id: row.id, is_test: row.is_test === true, is_public: row.is_public === true },
      message: row.is_test ? TEST_PROFILE_MARKED_TEXT : TEST_PROFILE_UNMARKED_TEXT,
    });
  } catch (err) {
    console.error('[admin/operators/test-profile] отметка не записана, SQLSTATE', sqlState(err));
    return NextResponse.json({ success: false, error: 'Отметка не сохранена: база не ответила' }, { status: 503 });
  }
}
