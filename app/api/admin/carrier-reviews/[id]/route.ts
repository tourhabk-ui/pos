/**
 * PATCH /api/admin/carrier-reviews/[id] — скрыть отзыв о перевозчике или
 * вернуть (миграция 1235). Скрыть — решение модератора с записанной причиной
 * не короче 8 символов (как у отзывов о турах, 878); то же требование держит
 * CHECK в базе. Рейтинг пересчитывать не нужно: он считается при чтении из
 * видимых отзывов.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { setCarrierReviewHidden } from '@/lib/transfers/carrier-reviews';
import { logText } from '@/lib/log/log-text';

export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ id: z.string().regex(/^\d{1,18}$/, 'Некорректный ID отзыва') });

const BodySchema = z.discriminatedUnion('hidden', [
  z.object({ hidden: z.literal(true), reason: z.string().trim().min(8, 'Причина скрытия — не короче 8 символов').max(500) }),
  z.object({ hidden: z.literal(false) }),
]);

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin(request);
  if (admin instanceof NextResponse) return admin;

  const p = ParamsSchema.safeParse(await params);
  if (!p.success) return NextResponse.json({ success: false, error: 'Некорректный ID отзыва' }, { status: 400 });
  const b = BodySchema.safeParse(await request.json().catch(() => null));
  if (!b.success) {
    return NextResponse.json({ success: false, error: b.error.issues[0]?.message ?? 'Некорректные данные' }, { status: 400 });
  }

  try {
    const row = await setCarrierReviewHidden(p.data.id, b.data.hidden, b.data.hidden ? b.data.reason : null);
    if (!row) return NextResponse.json({ success: false, error: 'Отзыв не найден' }, { status: 404 });
    return NextResponse.json({
      success: true,
      data: { id: row.id, hidden: b.data.hidden },
      message: b.data.hidden ? 'Отзыв скрыт' : 'Отзыв снова виден',
    });
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    console.error(
      `[admin/carrier-reviews] модерация не записана: sqlstate=${typeof code === 'string' ? code : 'нет'}`,
      logText(err instanceof Error ? err.message : err, 200),
    );
    return NextResponse.json({ success: false, error: 'Не удалось изменить отзыв' }, { status: 500 });
  }
}
