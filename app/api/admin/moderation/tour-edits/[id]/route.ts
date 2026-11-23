/**
 * POST /api/admin/moderation/tour-edits/[id] — одобрить или отклонить правку
 * тура либо просьбу о публикации (миграция 1507; план готовности 23.11, этап 4).
 *
 * Одобрение в той же транзакции применяет правку к живой строке тура и, если
 * тур просился на сайт, ставит публикацию. Отклонение живую строку не трогает.
 * Повторное решение не применяется.
 *
 * Одобрение несёт отпечаток содержания, которое модератор видел в карточке:
 * пока она была открыта, владелец мог дописать правку — тогда 409 и тур
 * прежний.
 *
 * После решения владельцу уходит сообщение в его MAX или Telegram — с
 * причиной отказа. Доставка решения не отменяет. Поисковикам об изменении
 * сообщаем только после одобрения: до него страница тура прежняя.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { notifyPartnerEditDecisionQuietly } from '@/lib/notifications/partner-edit-notify';
import { pingTourChanged } from '@/lib/seo/indexnow';
import { tourCabinetPath, tourFieldsWords } from '@/lib/tours/moderation';
import { decideTourEdit } from '@/lib/tours/moderation-review';

export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ id: z.string().uuid('Некорректный id правки') });
const uuidSchema = z.string().uuid();

const SEEN_MSG = 'Обновите страницу: одобрение без отпечатка карточки не принимается';

const BodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), seen: z.string({ message: SEEN_MSG }).regex(/^[0-9a-f]{64}$/, SEEN_MSG) }),
  z.object({
    action: z.literal('reject'),
    reason: z.string().trim().min(5, 'Укажите причину отказа — хотя бы 5 знаков').max(1000, 'Причина длиннее 1000 знаков'),
  }),
], { message: 'Действие: approve или reject' });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authOrResponse = await requireAdmin(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const parsedParams = ParamsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json({ success: false, error: 'Некорректный id правки' }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }

  const moderatedBy = uuidSchema.safeParse(authOrResponse.userId).success ? authOrResponse.userId : null;
  const reason = parsed.data.action === 'reject' ? parsed.data.reason : null;
  const decided = await decideTourEdit({
    id: parsedParams.data.id,
    action: parsed.data.action,
    reason,
    moderatedBy,
    seen: parsed.data.action === 'approve' ? parsed.data.seen : null,
  });

  if (decided.outcome === 'db_error') {
    return NextResponse.json({ success: false, error: 'Не смог записать решение. Тур не изменён.' }, { status: 503 });
  }
  if (decided.outcome === 'not_found') {
    return NextResponse.json({ success: false, error: 'Правка не найдена или тур удалён' }, { status: 404 });
  }
  if (decided.outcome === 'changed') {
    return NextResponse.json({
      success: false,
      code: 'changed',
      error: 'Владелец изменил правку, пока карточка была открыта. Тур не изменён — проверьте новую правку.',
    }, { status: 409 });
  }
  if (decided.outcome === 'bad_photo') {
    return NextResponse.json({
      success: false,
      code: 'bad_photo',
      error: 'В правке есть адрес снимка, который снимком не является. Тур не изменён — верните правку владельцу с причиной.',
    }, { status: 409 });
  }
  if (decided.outcome === 'place_gone') {
    return NextResponse.json({
      success: false,
      code: 'place_gone',
      error: 'Главное место из правки скрыто или слито в другое, пока правка ждала. Тур не изменён — верните правку владельцу с причиной.',
    }, { status: 409 });
  }
  if (decided.outcome === 'already') {
    return NextResponse.json({ success: false, error: 'По этой правке решение уже записано' }, { status: 409 });
  }

  if (decided.outcome === 'approved') pingTourChanged(decided.tourId);

  await notifyPartnerEditDecisionQuietly({
    partnerId: decided.partnerId,
    subject: 'tour',
    label: decided.title,
    outcome: decided.outcome,
    reason,
    firstPublication: decided.askedPublish,
    fieldsWords: tourFieldsWords(decided.fields),
    cabinetPath: tourCabinetPath(decided.partnerCategory),
  });

  const title = `«${decided.title}»`;
  return NextResponse.json({
    success: true,
    data: { id: parsedParams.data.id, outcome: decided.outcome, tourId: decided.tourId, published: decided.published },
    message: decided.outcome === 'approved'
      ? (decided.published ? `${title}: тур опубликован` : `${title}: правка на сайте`)
      : (decided.askedPublish ? `${title}: тур не опубликован` : `${title}: правка отклонена, на сайте прежняя версия`),
  });
}
