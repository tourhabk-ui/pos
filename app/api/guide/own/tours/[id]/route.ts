/**
 * PATCH /api/guide/own/tours/[id] — гид правит поля своего тура на сайте:
 * название, цену и её единицу, размер группы, анонс и описание; с 05.11 —
 * программу дня, что включено / не входит / что взять, правила безопасности
 * и фото (гид Андрей Запорожец: «непонятно, как отредактировать программу
 * или добавить фото к туру»). Пустой список или программа — null («снять»).
 * Фото — только адреса, которые выдаёт загрузка своего тура
 * (`POST /api/upload/tour-photo`): хранилище платформы или /images/, чужой
 * сайт на витрину гида не поставить.
 *
 * Запись — общая функция правки тура (`writeTourPatch`, lib/tours/tour-write)
 * — та же, что у кабинета оператора и у «Сохранить» в чате гида; владелец
 * проверяется в самом UPDATE (`operator_id` = карточка вошедшего гида). Чужой
 * или удалённый тур — 404, ни строки не тронуто. Публикация здесь не меняется:
 * на сайт и с сайта — `POST …/publish`, через витринный гейт.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/middleware';
import { getGuidePartnerId } from '@/lib/auth/guide-helpers';
import { transaction } from '@/lib/database';
import { writeTourPatch } from '@/lib/tours/tour-write';
import { pingTourChanged } from '@/lib/seo/indexnow';
import { OwnTourEditSchema as BodySchema } from '@/lib/guides/own-tour-edit';
import { zodErrorMessage } from '@/lib/api/zod-errors';

export const dynamic = 'force-dynamic';


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
  // «Снять список» — null от формы; колонки состава пишутся массивом, и
  // пустой массив карточка тура читает как «не записано», как и null.
  const emptied = (v: string[] | null | undefined) => (v === null ? [] : v);
  const input = {
    ...body.data,
    short_description: body.data.short_description === '' ? null : body.data.short_description,
    included: emptied(body.data.included),
    not_included: emptied(body.data.not_included),
    what_to_bring: emptied(body.data.what_to_bring),
  };

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
