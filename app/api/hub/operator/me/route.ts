/**
 * Кем вошедший приходится кабинету оператора: владелец или менеджер, и
 * какие права дал владелец (CRM фаза 2г). Читает меню кабинета: менеджеру
 * не показываются деньги и настройки, а цены — только с правом.
 *
 * Меню — удобство, а не защита: каждый роут денег и настроек сам зовёт
 * requireOperatorOwner (сторож operator-team-access).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireOperatorTeam } from '@/lib/operators/team-access';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const ctx = await requireOperatorTeam(request);
  if (ctx instanceof NextResponse) return ctx;
  const a = ctx.access;
  return NextResponse.json({
    success: true,
    data: a.kind === 'owner'
      ? { kind: 'owner', perms: { can_edit_prices: true, can_cancel_bookings: true } }
      : { kind: 'manager', perms: a.perms },
  });
}
