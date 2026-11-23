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
 * Запись — единая дверь владельца (`saveTourChange`, lib/tours/tour-change)
 * — та же, что у кабинета оператора и у «Сохранить» в чате гида; владелец
 * проверяется в самом UPDATE (`operator_id` = карточка вошедшего гида). Чужой
 * или удалённый тур — 404, ни строки не тронуто. Публикация здесь не меняется:
 * на сайт и с сайта — `POST …/publish`, через витринный гейт.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/middleware';
import { getGuidePartnerId } from '@/lib/auth/guide-helpers';
import { transaction } from '@/lib/database';
import { saveTourChange } from '@/lib/tours/tour-change';
import { lockPendingTourEdit } from '@/lib/tours/moderation-store';
import { setPhotoCaptions, writePhotoCredits } from '@/lib/tours/editor-media';
import { pingTourChanged } from '@/lib/seo/indexnow';
import { OwnTourEditSchema as BodySchema, keptStoredPhotos } from '@/lib/guides/own-tour-edit';
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
  // Подпись снимков — не колонка тура: она уходит в карту авторов партнёра.
  const { photo_credit: photoCredit, photo_captions: photoCaptions, ...fields } = body.data;
  const input = {
    ...fields,
    short_description: fields.short_description === '' ? null : fields.short_description,
    included: emptied(fields.included),
    not_included: emptied(fields.not_included),
    what_to_bring: emptied(fields.what_to_bring),
  };

  const partnerId = await getGuidePartnerId(auth.userId);
  if (!partnerId) {
    return NextResponse.json({ success: false, error: 'Карточка гида не найдена' }, { status: 404 });
  }

  try {
    const written = await transaction(async (c) => {
      // Снимок из хранилища (1406) пускается, только если он уже стоит у этого
      // тура: чужой снимок платформы на витрину гида не поставить.
      const kept = keptStoredPhotos(fields.photos ?? []);
      if (kept.length > 0) {
        const cur = await c.query<{ photos: string[] | null }>(
          `SELECT photos FROM operator_tours WHERE id = $1::bigint AND operator_id = $2::uuid AND deleted_at IS NULL FOR UPDATE`,
          [id, partnerId],
        );
        const have = new Set(cur.rows[0]?.photos ?? []);
        // Снимки правки, которая ждёт проверки, — тоже снимки этого тура:
        // форма показывает их и присылает обратно.
        const waiting = (await lockPendingTourEdit(c, id))?.patch as { photos?: unknown } | undefined;
        if (Array.isArray(waiting?.photos)) for (const u of waiting.photos) if (typeof u === 'string') have.add(u);
        if (kept.some((u) => !have.has(u))) return { outcome: 'foreign_photo' as const };
      }
      // Единая дверь владельца (lib/tours/tour-change): содержание
      // опубликованного тура уходит на проверку, остальное пишется сразу.
      const w = await saveTourChange(c, { tourId: id, ownerId: partnerId, userId: auth.userId, input, current: {} });
      const saved = w.outcome === 'written' || w.outcome === 'pending';
      // «Фото: <автор>» (05.11, слово владельца): снимкам тура без подписи —
      // автор из формы, в карту партнёра (partners.gallery_credits, её читает
      // карточка тура). Уже подписанное не переписывается.
      if (saved && photoCredit && fields.photos?.length) {
        await writePhotoCredits(c, partnerId, photoCredit, fields.photos);
      }
      // Подпись каждого снимка своей рукой (11.11) — после общей: правка
      // конкретного фото сильнее «чьи снимки». Только снимки этого тура.
      if (saved && photoCaptions) {
        await setPhotoCaptions(c, partnerId, id, photoCaptions);
      }
      return w;
    });
    if (written.outcome === 'foreign_photo') {
      return NextResponse.json({ success: false, error: 'Фото — только загруженное здесь же или уже стоящее у этого тура' }, { status: 400 });
    }
    if (written.outcome === 'empty') {
      return NextResponse.json({ success: false, error: 'Нечего сохранять' }, { status: 400 });
    }
    if (written.outcome === 'not_found') {
      return NextResponse.json({ success: false, error: 'Тур не найден среди ваших' }, { status: 404 });
    }
    // Сохранили форму без единой правки — успех, а не ошибка.
    if (written.outcome === 'unchanged') {
      return NextResponse.json({ success: true, data: { id, title: null }, pending: null, unchanged: true });
    }
    // Поисковикам — только о том, что изменилось на витрине.
    if (written.row) pingTourChanged(id);
    return NextResponse.json({
      success: true,
      data: { id, title: written.row?.title ?? null },
      pending: written.pending
        ? { fields: written.pending.fields, wantsPublish: written.pending.wantsPublish, notice: written.pending.notice }
        : null,
    });
  } catch (error) {
    const e = error as { code?: string };
    if (e?.code === '23514') {
      return NextResponse.json({ success: false, error: 'Размер группы меньше минимального числа участников тура' }, { status: 400 });
    }
    console.error('[guide/own/tours/[id]] правка тура — отказ:', `sqlstate=${e?.code ?? 'нет'}`);
    return NextResponse.json({ success: false, error: 'Не сохранено — попробуйте позже' }, { status: 503 });
  }
}
