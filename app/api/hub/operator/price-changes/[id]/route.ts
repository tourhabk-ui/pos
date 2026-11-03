/**
 * Подтверждение изменения цен с сайта — K.ai B3.
 * GET — что именно изменится (сохранённый предпросмотр) и состояние ссылки;
 * POST — применить. Вход обязателен, право can_edit_prices, свой кабинет.
 */
import { NextRequest, NextResponse } from 'next/server';
import { managerMay, permissionDenied, requireOperatorTeam } from '@/lib/operators/team-access';
import { pool } from '@/lib/db-pool';
import { transaction } from '@/lib/database';
import { pingTourChanged } from '@/lib/seo/indexnow';
import { confirmPendingChange, loadPendingChange } from '@/lib/crm/price-change';

export const dynamic = 'force-dynamic';

const STATE_TEXT = { used: 'Это изменение уже подтверждено — ссылка одноразовая', expired: 'Ссылка истекла (24 часа). Попросите Кузьмича ещё раз', not_found: 'Изменение не найдено' } as const;

async function gate(request: NextRequest) {
  const auth = await requireOperatorTeam(request);
  if (auth instanceof NextResponse) return auth;
  if (!managerMay(auth.access, 'can_edit_prices')) return permissionDenied('can_edit_prices');
  return auth;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await gate(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  try {
    const c = await loadPendingChange(pool, auth.partnerId, id, Date.now());
    if (!c) return NextResponse.json({ success: false, error: STATE_TEXT.not_found }, { status: 404 });
    return NextResponse.json({ success: true, data: c });
  } catch {
    console.error('[hub/operator/price-changes] не прочитано');
    return NextResponse.json({ success: false, error: 'Не удалось прочитать изменение' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await gate(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  try {
    const res = await transaction((client) => confirmPendingChange(client, auth.partnerId, id, auth.userId, Date.now()));
    if (res.outcome !== 'applied') {
      return NextResponse.json({ success: false, error: STATE_TEXT[res.outcome] }, { status: res.outcome === 'not_found' ? 404 : 409 });
    }
    for (const t of res.applied) pingTourChanged(BigInt(t));
    return NextResponse.json({ success: true, data: res });
  } catch {
    console.error('[hub/operator/price-changes] не применено');
    return NextResponse.json({ success: false, error: 'Не удалось применить изменение' }, { status: 500 });
  }
}
