/**
 * POST /api/hub/partner/offer — партнёр принимает оферту из кабинета (план
 * готовности 23.11, этап 5).
 *
 * Для тех, кто заведён до отметки на регистрации или администратором: в
 * журнале акцепта (1508) у них пусто. Принятие ничего не открывает и не
 * закрывает — заявки такому партнёру идут и без него; это запись о том, что
 * условия оферты приняты, с версией и временем.
 *
 * Партнёр берётся из входа, а не из запроса. Принимает владелец кабинета:
 * менеджер команды за компанию оферту не акцептует. Роль, которая не сторона
 * оферты (агент), акцепта не пишет. В теле — состояние отметки, сервер
 * проверяет пришедшее.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePartner } from '@/lib/crm/partner-context';
import { OFFER_REQUIRED_TEXT, OFFER_VERSION, isOfferRole } from '@/lib/legal/offer';
import { recordOfferAcceptanceForPartner } from '@/lib/legal/offer-acceptance';
import { getTrustedClientIp } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({ offer_accepted: z.literal(true, { message: OFFER_REQUIRED_TEXT }) });

export async function POST(req: NextRequest) {
  const ctx = await requirePartner(req);
  if (ctx instanceof NextResponse) return ctx;

  if (!isOfferRole(ctx.category)) {
    return NextResponse.json({ success: false, error: 'Вашей роли оферта для партнёров не нужна' }, { status: 400 });
  }
  if (ctx.seat !== 'owner') {
    return NextResponse.json({ success: false, error: 'Принять оферту может владелец кабинета' }, { status: 403 });
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: OFFER_REQUIRED_TEXT, code: 'offer_required' }, { status: 400 });
  }

  const saved = await recordOfferAcceptanceForPartner({
    partnerId: ctx.partnerId,
    userId: ctx.userId,
    ip: getTrustedClientIp(req.headers),
  });
  if (saved === 'db_error') {
    return NextResponse.json({ success: false, error: 'Отметка не записана — попробуйте позже' }, { status: 503 });
  }
  return NextResponse.json({ success: true, data: { version: OFFER_VERSION } });
}
