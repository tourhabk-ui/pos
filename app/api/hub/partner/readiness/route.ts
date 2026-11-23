/**
 * GET /api/hub/partner/readiness — чек-лист готовности партнёра принимать
 * заявки (план готовности 23.11, этап 3c). Один роут на все кабинеты.
 *
 * Партнёр берётся из входа (requirePartner), а не из запроса: чужую карточку
 * не спросить. В ответе нет ПД — флаги, числа и слова пунктов.
 * Роли, которой заявки не приходят (агент), чек-листа нет: data = null.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requirePartner } from '@/lib/crm/partner-context';
import { isReadinessCategory } from '@/lib/partners/readiness';
import { readPartnerReadiness } from '@/lib/partners/readiness-store';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const ctx = await requirePartner(req);
  if (ctx instanceof NextResponse) return ctx;
  if (!isReadinessCategory(ctx.category)) {
    return NextResponse.json({ success: true, data: null });
  }
  const data = await readPartnerReadiness({ partnerId: ctx.partnerId, category: ctx.category, viewer: ctx.seat });
  return NextResponse.json({ success: true, data });
}
