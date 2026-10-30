/**
 * POST /api/admin/moderation/charter-price-edits/[id] — одобрить или отклонить
 * черновик прайса перевозчика (1355).
 *
 * Одобрение в той же транзакции переписывает живую строку или вставляет новую.
 * Отклонение живой прайс не трогает. Повторное решение не применяется.
 *
 * Одобрение несёт поля, которые модератор видел в карточке: пока она была
 * открыта, перевозчик мог дописать черновик — тогда 409 и прайс прежний.
 * Новая строка, дубль которой уже есть в прайсе (одно направление на вид
 * машины), — 409 `duplicate`: черновик остаётся, отклоняется с причиной.
 *
 * После решения партнёру уходит сообщение в его MAX или Telegram — с
 * причиной отказа. Доставка решения не отменяет.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { notifyPartnerEditDecisionQuietly } from '@/lib/notifications/partner-edit-notify';
import { decidePriceEdit } from '@/lib/transfers/price-edit-store';

export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ id: z.string().uuid('Некорректный id правки') });
const uuidSchema = z.string().uuid();

const SEEN_MSG = 'Обновите страницу: одобрение без полей из карточки не принимается';

const SeenSchema = z.object({
  priceRub: z.number({ message: SEEN_MSG }).int().positive().nullable(),
  priceNote: z.string({ message: SEEN_MSG }).max(255).nullable(),
  conditions: z.string({ message: SEEN_MSG }).max(4000).nullable(),
  isActive: z.boolean({ message: SEEN_MSG }).nullable(),
  vehicleKind: z.string({ message: SEEN_MSG }).max(20).nullable(),
  lineKind: z.string({ message: SEEN_MSG }).max(12).nullable(),
  fromText: z.string({ message: SEEN_MSG }).max(255).nullable(),
  toText: z.string({ message: SEEN_MSG }).max(255).nullable(),
  validYear: z.number({ message: SEEN_MSG }).int().nullable(),
}, { message: SEEN_MSG });

const BodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), seen: SeenSchema }),
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
  const decided = await decidePriceEdit({
    id: parsedParams.data.id,
    action: parsed.data.action,
    reason,
    moderatedBy,
    seen: parsed.data.action === 'approve' ? parsed.data.seen : null,
  });

  if (decided.outcome === 'db_error') {
    return NextResponse.json({ success: false, error: 'Не смог записать решение. Прайс не изменён.' }, { status: 503 });
  }
  if (decided.outcome === 'not_found') {
    return NextResponse.json({ success: false, error: 'Правка не найдена' }, { status: 404 });
  }
  if (decided.outcome === 'changed') {
    return NextResponse.json({
      success: false,
      code: 'changed',
      error: 'Перевозчик изменил черновик, пока карточка была открыта. Прайс не изменён — проверьте новую правку.',
    }, { status: 409 });
  }
  if (decided.outcome === 'duplicate') {
    return NextResponse.json({
      success: false,
      code: 'duplicate',
      error: `${decided.label}: такая строка в прайсе уже есть. Прайс не изменён — отклоните черновик с причиной или попросите перевозчика править существующую строку.`,
    }, { status: 409 });
  }
  if (decided.outcome === 'already') {
    return NextResponse.json({ success: false, error: 'По этой правке решение уже записано' }, { status: 409 });
  }

  await notifyPartnerEditDecisionQuietly({
    partnerId: decided.partnerId,
    subject: 'charter',
    label: decided.label,
    outcome: decided.outcome,
    reason,
  });

  return NextResponse.json({
    success: true,
    data: { id: parsedParams.data.id, outcome: decided.outcome, label: decided.label },
    message: decided.outcome === 'approved'
      ? `${decided.label}: правка на сайте`
      : `${decided.label}: правка отклонена, на сайте прежняя строка`,
  });
}
