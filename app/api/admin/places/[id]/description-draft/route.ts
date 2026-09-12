/**
 * GET /api/admin/places/[id]/description-draft — прочитать черновик описания
 * (оригинал ГВП + перевод) для ревью.
 * PATCH — одобрить (публикует в places.description) или отклонить.
 *
 * #1830: перевод + проверка, НЕ автовставка. `POST /api/cron/place-description-drafts`
 * только ПРЕДЛАГАЕТ черновик; здесь — единственное место, откуда текст может
 * попасть в живую колонку `places.description`, и только явным решением
 * админа.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { query, transaction } from '@/lib/database';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  action: z.enum(['approve', 'reject']),
  // Админ может поправить перевод перед публикацией — не обязан принимать
  // текст модели дословно (§4.0: проверка обязана уметь не согласиться).
  editedText: z.string().min(1).max(5000).optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authOrResponse = await requireAdmin(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const { id } = await params;

  const result = await query<{
    place_id: string; source: string; source_ref: string;
    original_text: string; translated_text: string; model: string;
    status: string; created_at: string; reviewed_at: string | null;
  }>(
    `SELECT place_id, source, source_ref, original_text, translated_text, model, status, created_at, reviewed_at
       FROM place_description_drafts
      WHERE place_id = $1 AND source = 'gvp'`,
    [id],
  );

  if (result.rows.length === 0) {
    return NextResponse.json({ success: false, error: 'Черновик не найден' }, { status: 404 });
  }

  return NextResponse.json({ success: true, draft: result.rows[0] });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authOrResponse = await requireAdmin(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const { id } = await params;

  const body: unknown = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ success: false, error: 'Неверный JSON' }, { status: 400 });

  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message }, { status: 400 });
  }
  const { action, editedText } = parsed.data;

  const draftResult = await query<{ translated_text: string; status: string }>(
    `SELECT translated_text, status FROM place_description_drafts WHERE place_id = $1 AND source = 'gvp'`,
    [id],
  );
  if (draftResult.rows.length === 0) {
    return NextResponse.json({ success: false, error: 'Черновик не найден' }, { status: 404 });
  }
  if (draftResult.rows[0].status !== 'pending') {
    return NextResponse.json(
      { success: false, error: `Черновик уже рассмотрен (${draftResult.rows[0].status})` },
      { status: 409 },
    );
  }

  const finalText = editedText ?? draftResult.rows[0].translated_text;

  await transaction(async (client) => {
    await client.query(
      `UPDATE place_description_drafts
          SET status = $2, reviewed_at = NOW(), translated_text = $3
        WHERE place_id = $1 AND source = 'gvp'`,
      [id, action === 'approve' ? 'approved' : 'rejected', finalText],
    );

    if (action === 'approve') {
      await client.query(
        `UPDATE places SET description = $2, updated_at = NOW() WHERE id = $1`,
        [id, finalText],
      );
    }
  });

  return NextResponse.json({ success: true, action, publishedToDescription: action === 'approve' });
}
