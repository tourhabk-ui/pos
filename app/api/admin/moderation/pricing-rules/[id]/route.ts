/**
 * POST /api/admin/moderation/pricing-rules/[id] — одобрить или отклонить
 * скидку / наценку тура либо просьбу снять действующее правило (миграция 1513).
 *
 * Одобрение нового правила в одной транзакции выключает прежнее действующее
 * правило того же рода и включает новое. Отказ цену не меняет. Повторное
 * решение не применяется.
 *
 * Одобрение несёт отпечаток того, что модератор видел в карточке: правило,
 * заменённое владельцем после показа, по старой карточке не одобрить.
 *
 * После решения владельцу уходит сообщение в его MAX или Telegram — с
 * причиной отказа и тем, что стало с ценой на сайте. Доставка решения не
 * отменяет.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { notifyPartnerEditDecisionQuietly } from '@/lib/notifications/partner-edit-notify';
import { pingTourChanged } from '@/lib/seo/indexnow';
import { decidePricingRule } from '@/lib/tours/pricing-rule-review';

export const dynamic = 'force-dynamic';

const ParamsSchema = z.object({ id: z.string().regex(/^\d{1,18}$/, 'Некорректный id правила') });
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
    return NextResponse.json({ success: false, error: 'Некорректный id правила' }, { status: 400 });
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
  const decided = await decidePricingRule({
    id: parsedParams.data.id,
    action: parsed.data.action,
    reason,
    moderatedBy,
    seen: parsed.data.action === 'approve' ? parsed.data.seen : null,
  });

  if (decided.outcome === 'db_error') {
    return NextResponse.json({ success: false, error: 'Не смог записать решение. Цена не изменена.' }, { status: 503 });
  }
  if (decided.outcome === 'not_found') {
    return NextResponse.json({ success: false, error: 'Правило не найдено или тур удалён' }, { status: 404 });
  }
  if (decided.outcome === 'changed') {
    return NextResponse.json({
      success: false,
      code: 'changed',
      error: 'Правило изменилось, пока карточка была открыта. Цена не изменена — проверьте правило заново.',
    }, { status: 409 });
  }
  if (decided.outcome === 'already') {
    return NextResponse.json({ success: false, error: 'По этому правилу решение уже записано или владелец его отозвал' }, { status: 409 });
  }

  // Цена на странице тура изменилась только после одобрения.
  if (decided.outcome === 'approved') pingTourChanged(decided.tourId);

  await notifyPartnerEditDecisionQuietly({
    partnerId: decided.partnerId,
    subject: 'pricing_rule',
    label: decided.tourTitle,
    outcome: decided.outcome,
    reason,
    ruleWords: decided.words,
    ruleKind: decided.kind,
  });

  const title = `«${decided.tourTitle}»`;
  const message = decided.kind === 'removal'
    ? (decided.outcome === 'approved' ? `${title}: правило снято` : `${title}: в снятии отказано, правило действует`)
    : (decided.outcome === 'approved' ? `${title}: правило действует на сайте` : `${title}: правило отклонено, цена прежняя`);
  return NextResponse.json({
    success: true,
    data: { id: parsedParams.data.id, outcome: decided.outcome, kind: decided.kind, tourId: decided.tourId },
    message,
  });
}
