/**
 * POST /api/guide/own/tours/[id]/publish — гид выводит свой тур на сайт
 * (`{ publish: true }`) или снимает с сайта (`{ publish: false }`).
 *
 * Одна функция с кнопками «Опубликовать» / «Снять с сайта» в чате кабинета —
 * `setOwnTourOnSite` (lib/guides/own-tour-publish): витринный гейт тем же SQL,
 * владение в UPDATE, ответ шлюза каталога, пинг IndexNow после записи. Гейт не
 * пройден — 409 и перечень того, чего не хватает; тур остаётся черновиком.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth/middleware';
import { getGuidePartnerId } from '@/lib/auth/guide-helpers';
import { setOwnTourOnSite } from '@/lib/guides/own-tour-publish';
import { publishBlockerLabel } from '@/lib/guides/own-tour-words';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({ publish: z.boolean() }).strict();

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireRole(request, ['guide']);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  if (!/^\d{1,18}$/.test(id)) {
    return NextResponse.json({ success: false, error: 'Некорректный номер тура' }, { status: 400 });
  }
  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ success: false, error: 'Укажите, публиковать тур или снять с сайта' }, { status: 400 });
  }

  const partnerId = await getGuidePartnerId(auth.userId);
  if (!partnerId) {
    return NextResponse.json({ success: false, error: 'Карточка гида не найдена' }, { status: 404 });
  }

  const r = await setOwnTourOnSite({ ownerId: partnerId, tourId: id, publish: body.data.publish });
  switch (r.outcome) {
    case 'not_found':
      return NextResponse.json({ success: false, error: 'Тур не найден среди ваших' }, { status: 404 });
    case 'db_error':
      return NextResponse.json({ success: false, error: 'Не записано — база не ответила, тур остался как был' }, { status: 503 });
    case 'blocked':
      return NextResponse.json({
        success: false,
        outcome: r.outcome,
        error: `Тур остался черновиком — не хватает: ${r.blockers.map(publishBlockerLabel).join('; ')}`,
        blockers: r.blockers,
      }, { status: 409 });
    case 'published':
      return NextResponse.json({ success: true, outcome: r.outcome, message: `«${r.title}» опубликован — туристы его видят` });
    case 'already_on':
      return NextResponse.json({ success: true, outcome: r.outcome, message: `«${r.title}» уже на сайте` });
    case 'unpublished':
      return NextResponse.json({ success: true, outcome: r.outcome, message: `«${r.title}» снят с сайта — теперь черновик` });
    case 'already_off':
      return NextResponse.json({ success: true, outcome: r.outcome, message: `«${r.title}» и так не на сайте` });
  }
}
