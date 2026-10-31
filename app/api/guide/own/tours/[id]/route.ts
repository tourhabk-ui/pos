/**
 * PATCH /api/guide/own/tours/[id] — гид правит поля своего тура на сайте:
 * название, цену и её единицу, размер группы, анонс и описание.
 *
 * Запись — общая функция правки тура (`writeTourPatch`, lib/tours/tour-write)
 * — та же, что у кабинета оператора и у «Сохранить» в чате гида; владелец
 * проверяется в самом UPDATE (`operator_id` = карточка вошедшего гида). Чужой
 * или удалённый тур — 404, ни строки не тронуто. Публикация здесь не меняется:
 * на сайт и с сайта — `POST …/publish`, через витринный гейт.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth/middleware';
import { getGuidePartnerId } from '@/lib/auth/guide-helpers';
import { transaction } from '@/lib/database';
import { writeTourPatch } from '@/lib/tours/tour-write';
import { pingTourChanged } from '@/lib/seo/indexnow';
import { OwnTourDraftSchema } from '@/lib/guides/own-tour-create';
import { zodErrorMessage } from '@/lib/api/zod-errors';

export const dynamic = 'force-dynamic';

const BodySchema = OwnTourDraftSchema.pick({
  title: true, base_price: true, max_participants: true, description: true,
}).extend({
  price_unit: z.enum(['per_person', 'per_tour']),
  short_description: z.string().trim().max(500).nullable(),
}).partial().strict();

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(request, ['guide']);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  if (!/^\d{1,18}$/.test(id)) {
    return NextResponse.json({ success: false, error: 'Некорректный номер тура' }, { status: 400 });
  }
  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ success: false, error: zodErrorMessage(body.error) }, { status: 400 });
  }
  const input = { ...body.data, short_description: body.data.short_description === '' ? null : body.data.short_description };

  const partnerId = await getGuidePartnerId(auth.userId);
  if (!partnerId) {
    return NextResponse.json({ success: false, error: 'Карточка гида не найдена' }, { status: 404 });
  }

  try {
    const written = await transaction((c) => writeTourPatch(c, { tourId: id, ownerId: partnerId, input, current: {} }));
    if (written.outcome === 'empty') {
      return NextResponse.json({ success: false, error: 'Нечего сохранять' }, { status: 400 });
    }
    if (written.outcome === 'not_found') {
      return NextResponse.json({ success: false, error: 'Тур не найден среди ваших' }, { status: 404 });
    }
    pingTourChanged(id);
    return NextResponse.json({ success: true, data: { id: written.row.id, title: written.row.title } });
  } catch (error) {
    const e = error as { code?: string };
    if (e?.code === '23514') {
      return NextResponse.json({ success: false, error: 'Размер группы меньше минимального числа участников тура' }, { status: 400 });
    }
    console.error('[guide/own/tours/[id]] правка тура — отказ:', `sqlstate=${e?.code ?? 'нет'}`);
    return NextResponse.json({ success: false, error: 'Не сохранено — попробуйте позже' }, { status: 503 });
  }
}
