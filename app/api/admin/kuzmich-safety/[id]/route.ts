/**
 * POST /api/admin/kuzmich-safety/[id] — отметка разбора (#2300): «верно» или
 * «ошибка» с необязательной заметкой. Кто отметил — пишется.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { query } from '@/lib/database';
import { safeMsg } from '@/lib/errors/sanitize';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  mark: z.enum(['correct', 'wrong'], { message: 'Отметка: correct или wrong' }),
  note: z.string().trim().max(1000, 'Заметка — до 1000 знаков').optional(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  if (!/^\d+$/.test(id)) return NextResponse.json({ success: false, error: 'Неверный номер записи' }, { status: 400 });
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Неверный формат запроса' }, { status: 400 });
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Неверные данные' }, { status: 400 });
  }
  try {
    const r = await query<{ id: string }>(
      `UPDATE kuzmich_safety_reviews
          SET review_mark = $2, review_note = $3, reviewed_by = $4, reviewed_at = NOW()
        WHERE id = $1::bigint
        RETURNING id::text`,
      [id, parsed.data.mark, parsed.data.note ?? null, auth.email || auth.userId],
    );
    if (!r.rows[0]) return NextResponse.json({ success: false, error: 'Запись не найдена (хранится 30 дней)' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[admin/kuzmich-safety] отметка не записана', safeMsg(error));
    return NextResponse.json({ success: false, error: 'Отметка не записалась, попробуйте позже.' }, { status: 503 });
  }
}
