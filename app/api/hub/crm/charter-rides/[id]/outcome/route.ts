/**
 * POST /api/hub/crm/charter-rides/[id]/outcome — «Поездка состоялась» или
 * «Не состоялась» из «Входящих» кабинета перевозчика на сайте (#2862 этап B,
 * 30.10). Та же функция, что у кнопки в MAX и Telegram — recordRideOutcome
 * (lib/transfers/ride-outcome-flow): заявка его, «Беру» был, поездка
 * закончилась, исход один раз; «состоялась» выдаёт заказчику ссылку на
 * отзыв (подтвердил перевозчик, род charter_carrier). Своей записи здесь нет.
 *
 * Право — вход в кабинет перевозчика (`requirePartner`, категория transfer).
 * Имя и телефон заказчика роут не читает и не отдаёт.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePartner } from '@/lib/crm/partner-context';
import { isLeadId } from '@/lib/rental/request-answer';
import { loadRentalActor } from '@/lib/rental/web-cabinet';
import { recordRideOutcome } from '@/lib/transfers/ride-outcome-flow';
import { rideTellStatus, rideTellText } from '@/lib/transfers/ride-outcome';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

const BodySchema = z.object({ outcome: z.enum(['held', 'not_held']) }).strict();

export async function POST(req: NextRequest, { params }: Ctx) {
  const ctx = await requirePartner(req);
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.category !== 'transfer') {
    return NextResponse.json({ success: false, error: 'Исход поездки по заявке на машину записывает перевозчик' }, { status: 403 });
  }

  const { id } = await params;
  if (!isLeadId(id)) {
    return NextResponse.json({ success: false, error: 'Неверный номер заявки' }, { status: 400 });
  }
  const body = BodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ success: false, error: 'Исход — «состоялась» или «не состоялась»' }, { status: 400 });
  }

  const actor = await loadRentalActor(ctx.partnerId);
  if (actor.outcome !== 'ok') {
    return NextResponse.json({ success: false, error: 'Не удалось прочитать карточку. Исход не записан.' }, { status: 503 });
  }

  const { tell } = await recordRideOutcome({
    partner: { ...actor.actor, userId: ctx.userId },
    leadId: id,
    outcome: body.data.outcome,
    via: 'site',
  });
  const status = rideTellStatus(tell);
  // На сайте строку рисует React — без разметки чата.
  const message = rideTellText(tell).replace(/<\/?b>/g, '');
  return NextResponse.json(
    status === 200
      ? { success: true, outcome: tell.kind, message }
      : { success: false, outcome: tell.kind, error: message },
    { status },
  );
}
