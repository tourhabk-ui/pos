/**
 * POST /api/hub/crm/charter-requests/[id]/answer — «Беру» или «Не могу» на
 * заявку на машину целиком из «Входящих» кабинета перевозчика на сайте
 * (#2862 этап A, 30.10). Третья дверь к одному правилу — answerRentalRequest
 * (lib/rental/request-answer-flow): заявка его, ответ один раз, статус лида,
 * сообщение заказчику в переписку, менеджеру — факт без ПД. Своей записи
 * здесь нет.
 *
 * Право — вход в кабинет перевозчика (`requirePartner`, категория transfer)
 * и заявка, адресованная его карточке (operator_id в SQL хранилища). Чужая
 * заявка отвечает «не ваша», несуществующая — «не нашёл»; имя и телефон
 * заказчика роут не читает и не отдаёт.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePartner } from '@/lib/crm/partner-context';
import { isLeadId } from '@/lib/rental/request-answer';
import { answerRentalRequest } from '@/lib/rental/request-answer-flow';
import { answerTellPlain, answerTellStatus, loadRentalActor } from '@/lib/rental/web-cabinet';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const BodySchema = z.object({ answer: z.enum(['take', 'decline']) }).strict();

export async function POST(req: NextRequest, { params }: Ctx) {
  const ctx = await requirePartner(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.category !== 'transfer') {
    return NextResponse.json({ success: false, error: 'На заявки на машину отвечает перевозчик' }, { status: 403 });
  }

  const { id } = await params;
  if (!isLeadId(id)) {
    return NextResponse.json({ success: false, error: 'Неверный номер заявки' }, { status: 400 });
  }
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ success: false, error: 'Ответ — «беру» или «не могу»' }, { status: 400 });
  }

  const actor = await loadRentalActor(ctx.partnerId);
  if (actor.outcome !== 'ok') {
    return NextResponse.json({ success: false, error: 'Не удалось прочитать карточку. Ответ не записан.' }, { status: 503 });
  }

  const { tell } = await answerRentalRequest({
    partner: { ...actor.actor, userId: ctx.userId },
    leadId: id,
    answer: body.data.answer,
    via: 'site',
  });
  const status = answerTellStatus(tell);
  return NextResponse.json(
    status === 200
      ? { success: true, outcome: tell.kind, message: answerTellPlain(tell) }
      : { success: false, outcome: tell.kind, error: answerTellPlain(tell) },
    { status },
  );
}
