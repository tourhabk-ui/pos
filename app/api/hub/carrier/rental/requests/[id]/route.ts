/**
 * POST /api/hub/carrier/rental/requests/[id] — «Беру» или «Не могу» на заявку
 * проката из кабинета на сайте. Правило то же, что у кнопки в MAX
 * (answerRentalRequest): заявка его, ответ один раз, «Беру» отмечает дни
 * машины занятыми одной транзакцией с ответом, менеджеру — факт без ПД.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireCarrier } from '@/lib/transfers/carrier-auth';
import { isLeadId } from '@/lib/rental/request-answer';
import { answerRentalRequest } from '@/lib/rental/request-answer-flow';
import { answerTellPlain, answerTellStatus, loadRentalActor } from '@/lib/rental/web-cabinet';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({ answer: z.enum(['take', 'decline']) });

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const carrier = await requireCarrier(request);
  if (carrier instanceof NextResponse) return carrier;

  const { id } = await params;
  if (!isLeadId(id)) {
    return NextResponse.json({ success: false, error: 'Неверный номер заявки' }, { status: 400 });
  }
  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ success: false, error: 'Ответ — «беру» или «не могу»' }, { status: 400 });
  }

  const actor = await loadRentalActor(carrier.partnerId);
  if (actor.outcome !== 'ok') {
    return NextResponse.json(
      { success: false, error: 'Не удалось прочитать карточку. Ответ не записан.' },
      { status: 503 },
    );
  }

  const { tell } = await answerRentalRequest({ partner: actor.actor, leadId: id, answer: body.data.answer });
  const status = answerTellStatus(tell);
  return NextResponse.json(
    status === 200
      ? { success: true, outcome: tell.kind, message: answerTellPlain(tell) }
      : { success: false, outcome: tell.kind, error: answerTellPlain(tell) },
    { status },
  );
}
