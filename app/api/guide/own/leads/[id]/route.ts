/**
 * PATCH /api/guide/own/leads/[id] — гид отмечает ответ на заявку своего тура:
 * связался, обсуждаем, договорились, отказ. Правило то же, что у кабинета
 * оператора (lib/leads/owner-lead-status): прежний статус под блокировкой,
 * событие в ленте клиента только при настоящей смене. Скоуп гида уже, чем у
 * оператора: только заявки, адресованные его карточке, — ничейную гид не
 * видит и не занимает, чужая неотличима от несуществующей (404).
 *
 * До 29.10 заявка гида только читалась в «Свои туры», а дверь заявок
 * (`/api/leads/[id]`) пускала одного оператора: ответить было нечем, и во
 * «Входящие» гида заявку класть было нельзя — висела бы вечно.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth/middleware';
import { getGuidePartnerId } from '@/lib/auth/guide-helpers';
import { changeLeadStatus } from '@/lib/leads/owner-lead-status';
import { OWNER_LEAD_STATUSES } from '@/lib/leads/owner-lead-words';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BodySchema = z.object({
  status: z.enum(OWNER_LEAD_STATUSES),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ success: false, error: 'Неверный номер заявки' }, { status: 400 });
  }
  const auth = await requireRole(request, ['guide']);
  if (auth instanceof NextResponse) return auth;

  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json(
      { success: false, error: 'Отметка — «связался», «обсуждаем», «договорились» или «отказ»' },
      { status: 400 },
    );
  }

  const partnerId = await getGuidePartnerId(auth.userId);
  if (!partnerId) {
    return NextResponse.json({ success: false, error: 'Карточка гида не найдена' }, { status: 404 });
  }

  try {
    const outcome = await changeLeadStatus({
      leadId: id,
      status: body.data.status,
      actor: { kind: 'partner_user', userId: auth.userId },
      scope: { kind: 'owner', partnerId, claimUnowned: false },
      via: 'site',
    });
    if (outcome.kind === 'not_found') {
      return NextResponse.json({ success: false, error: 'Заявка не найдена среди ваших' }, { status: 404 });
    }
    return NextResponse.json({
      success: true,
      changed: outcome.changed,
      data: { id: outcome.lead.id, status: outcome.lead.status },
    });
  } catch (e) {
    const err = e as { code?: string };
    console.error('[guide/own/leads] отметка заявки не записана:', `sqlstate=${err?.code ?? 'нет'}`);
    return NextResponse.json({ success: false, error: 'Не удалось записать — попробуйте ещё раз' }, { status: 503 });
  }
}
