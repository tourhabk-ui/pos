/**
 * GET /api/hub/crm/channel — дойдёт ли до партнёра напоминание и заявка
 * (CRM 1в-3, #2325). Отвечает тем же правилом, по которому доставляют
 * (`reachForPartner`): MAX — partners.max_chat_id, Telegram — колонка
 * партнёра либо аккаунт его человека. Самих адресов не отдаёт — только
 * «есть / нет».
 *
 * Не смогли прочитать — 503, а не «не подключено»: баннер «подключите
 * канал» на сбое базы соврал бы тому, у кого всё подключено (§4.0).
 *
 * Только владелец кабинета (CRM 2г): баннер «подключите канал» обращён к
 * нему; менеджеру ответ 403, и баннер у него не показывается.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requirePartnerOwner } from '@/lib/crm/partner-context';
import { reachForPartner } from '@/lib/partners/reach';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requirePartnerOwner(req);
  if (ctx instanceof NextResponse) return ctx;
  const reach = await reachForPartner(ctx.partnerId);
  if (!reach) {
    return NextResponse.json({ success: false, error: 'Не удалось проверить подключение, попробуйте позже' }, { status: 503 });
  }
  return NextResponse.json({
    success: true,
    data: { reachable: reach.reachable, max: reach.maxChatId !== null, telegram: reach.telegramChatId !== null },
  });
}
