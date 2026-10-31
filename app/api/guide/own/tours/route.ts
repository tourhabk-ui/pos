/**
 * POST /api/guide/own/tours — гид создаёт свой тур в разделе «Свои туры»
 * (слово владельца 31.10: гид сам создаёт свои туры).
 *
 * Тур создаётся ЧЕРНОВИКОМ — общей функцией сайта и чата
 * (`createOwnTourDraft`, lib/guides/own-tour-create); туристу не виден. На сайт
 * его выводит гид кнопкой «Опубликовать» (`POST /api/guide/own/tours/[id]/publish`).
 * В ответе — чего не хватает до сайта, тем же гейтом, что у кнопки.
 *
 * Кто вправе — карточка вошедшего гида (`getGuidePartnerId`), не параметр.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth/middleware';
import { getGuidePartnerId } from '@/lib/auth/guide-helpers';
import { transaction } from '@/lib/database';
import { createOwnTourDraft, OwnTourDraftSchema } from '@/lib/guides/own-tour-create';
import { readPublishGate } from '@/lib/guides/own-tour-publish';
import { zodErrorMessage } from '@/lib/api/zod-errors';

export const dynamic = 'force-dynamic';

/** С сайта — поля формы; программу и списки гид дописывает правкой. */
const BodySchema = OwnTourDraftSchema.pick({
  title: true, base_price: true, price_unit: true, max_participants: true, description: true, short_description: true,
});

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, ['guide']);
  if (auth instanceof NextResponse) return auth;

  const raw = await request.json().catch(() => null);
  const body = BodySchema.safeParse(raw);
  if (!body.success) {
    return NextResponse.json({ success: false, error: zodErrorMessage(body.error) }, { status: 400 });
  }

  const partnerId = await getGuidePartnerId(auth.userId);
  if (!partnerId) {
    return NextResponse.json({ success: false, error: 'Карточка гида не найдена' }, { status: 404 });
  }

  try {
    const made = await transaction((c) => createOwnTourDraft(c, { ownerId: partnerId, userId: auth.userId, input: body.data }));
    if (made.outcome !== 'created') {
      return NextResponse.json({ success: false, error: 'Создавать туры может карточка гида' }, { status: 403 });
    }
    const gate = await readPublishGate(partnerId, made.tour.id);
    return NextResponse.json({
      success: true,
      data: {
        id: made.tour.id,
        title: made.tour.title,
        // null — гейт не прочитался (база не ответила): «не знаю», а не «всего хватает».
        blockers: gate.outcome === 'ok' ? gate.blockers : null,
      },
    }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: zodErrorMessage(error) }, { status: 400 });
    }
    const e = error as { code?: string };
    console.error('[guide/own/tours] создание тура — отказ:', `sqlstate=${e?.code ?? 'нет'}`);
    return NextResponse.json({ success: false, error: 'Тур не создан — попробуйте позже' }, { status: 503 });
  }
}
