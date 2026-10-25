/**
 * POST /api/admin/moderation/rental-edits/[id] — одобрить или отклонить черновик.
 *
 * Одобрение в той же транзакции переписывает цену и описание живой строки.
 * Отклонение живую строку не трогает. Повторное решение не применяется второй раз.
 *
 * Одобрение несёт цену и описание, которые модератор видел в карточке. Пока
 * она была открыта, прокатчик мог переписать тот же черновик: тогда 409 и
 * прайс не меняется — одобряется только проверенное.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { decideOfferEdit } from '@/lib/rental/offer-edit-store';

export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ id: z.string().uuid('Некорректный id правки') });
const uuidSchema = z.string().uuid();

const BodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('approve'),
    seenPrice: z.number({ message: 'Обновите страницу: одобрение без цены из карточки не принимается' })
      .int().positive().nullable(),
    seenConditions: z.string({ message: 'Обновите страницу: одобрение без описания из карточки не принимается' })
      .max(4000).nullable(),
  }),
  z.object({
    action: z.literal('reject'),
    reason: z.string().trim().min(5, 'Укажите причину отказа — хотя бы 5 знаков').max(1000, 'Причина длиннее 1000 знаков'),
  }),
], { message: 'Действие: approve или reject' });

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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
  const seen = parsed.data.action === 'approve'
    ? { price: parsed.data.seenPrice, conditions: parsed.data.seenConditions }
    : null;
  const decided = await decideOfferEdit({
    id: parsedParams.data.id,
    action: parsed.data.action,
    reason,
    moderatedBy,
    seen,
  });

  if (decided.outcome === 'db_error') {
    return NextResponse.json(
      { success: false, error: 'Не смог записать решение. Прайс не изменён.' },
      { status: 503 },
    );
  }
  if (decided.outcome === 'not_found') {
    return NextResponse.json({ success: false, error: 'Правка не найдена' }, { status: 404 });
  }
  if (decided.outcome === 'changed') {
    return NextResponse.json(
      {
        success: false,
        code: 'changed',
        error: 'Прокатчик изменил черновик, пока карточка была открыта. Прайс не изменён — проверьте новую правку.',
      },
      { status: 409 },
    );
  }
  if (decided.outcome === 'already') {
    return NextResponse.json({ success: false, error: 'По этой правке решение уже записано' }, { status: 409 });
  }
  return NextResponse.json({
    success: true,
    data: { id: parsedParams.data.id, outcome: decided.outcome, title: decided.title },
    message: decided.outcome === 'approved'
      ? `«${decided.title}»: правка на сайте`
      : `«${decided.title}»: правка отклонена, на сайте прежняя строка`,
  });
}
