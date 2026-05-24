import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  verified: z.boolean(),
});

interface Props {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: NextRequest, { params }: Props) {
  const authError = await requireAdmin(request);
  if (authError instanceof NextResponse) return authError;

  const { id } = await params;

  if (!/^[0-9a-f-]{36}$/.test(id)) {
    return NextResponse.json({ error: 'Неверный идентификатор' }, { status: 400 });
  }

  const body: unknown = await request.json().catch(() => ({}));
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Требуется поле verified (boolean)' },
      { status: 400 },
    );
  }

  const { verified } = parsed.data;

  const { rowCount } = await pool.query(
    `UPDATE ai_route_images
     SET photo_verified    = $1,
         manually_reviewed = TRUE
     WHERE id = $2`,
    [verified, id],
  );

  if (!rowCount) {
    return NextResponse.json({ error: 'Фото не найдено' }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
