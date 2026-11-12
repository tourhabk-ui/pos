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
import { LEAD_CANCELLED_STATUS_TEXT } from '@/lib/leads/client-cancelled';
import { LEAD_CLIENT_CANCELLED } from '@/lib/types/statuses';
import {
  LOST_REASONS, LOST_REASON_ONLY_WITH_LOST, LOST_REASON_REQUIRED, LOST_REASON_UNKNOWN,
} from '@/lib/leads/lost-reason';
import { closeLeadWithReason } from '@/lib/leads/seller-lost-flow';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BodySchema = z.object({
  status: z.enum(OWNER_LEAD_STATUSES),
  /** Причина отказа — вместе со `status: 'lost'` (этап 3а, lib/leads/lost-reason). */
  lostReason: z.enum(LOST_REASONS).optional(),
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
    // Причина не из списка — о ней и сказано: «отметка — связался…» здесь увело бы не туда.
    if (body.error.issues.some((i) => i.path[0] === 'lostReason')) {
      return NextResponse.json({ success: false, error: LOST_REASON_UNKNOWN }, { status: 422 });
    }
    return NextResponse.json(
      { success: false, error: 'Отметка — «связался», «обсуждаем», «договорились» или «отказ»' },
      { status: 400 },
    );
  }

  const partnerId = await getGuidePartnerId(auth.userId);
  if (!partnerId) {
    return NextResponse.json({ success: false, error: 'Карточка гида не найдена' }, { status: 404 });
  }

  // «Отказ» — только с причиной (этап 3а): от неё зависит, уйдёт ли человеку сообщение.
  if (body.data.status === 'lost' && !body.data.lostReason) {
    return NextResponse.json({ success: false, error: LOST_REASON_REQUIRED }, { status: 422 });
  }
  // Причина с другой отметкой молча не отбрасывается (§4.0).
  if (body.data.status !== 'lost' && body.data.lostReason) {
    return NextResponse.json({ success: false, error: LOST_REASON_ONLY_WITH_LOST }, { status: 422 });
  }

  try {
    const actor = { kind: 'partner_user' as const, userId: auth.userId };
    const scope = { kind: 'owner' as const, partnerId, claimUnowned: false };
    let touristLine: string | null = null;
    let outcome;
    if (body.data.status === 'lost' && body.data.lostReason) {
      const closed = await closeLeadWithReason({ leadId: id, reason: body.data.lostReason, actor, scope, via: 'site' });
      outcome = closed.outcome;
      touristLine = closed.touristLine;
    } else {
      outcome = await changeLeadStatus({ leadId: id, status: body.data.status, actor, scope, via: 'site' });
    }
    if (outcome.kind === 'not_found') {
      return NextResponse.json({ success: false, error: 'Заявка не найдена среди ваших' }, { status: 404 });
    }
    // Заявку отменил клиент (1427): отметка не записана — «уже отмечена» здесь было бы неправдой.
    if (outcome.prevStatus === LEAD_CLIENT_CANCELLED) {
      return NextResponse.json({ success: false, error: LEAD_CANCELLED_STATUS_TEXT }, { status: 409 });
    }
    return NextResponse.json({
      success: true,
      changed: outcome.changed,
      data: { id: outcome.lead.id, status: outcome.lead.status },
      // Что на деле ушло человеку после отказа с причиной; null — отказ этим запросом не записан.
      tourist: touristLine,
    });
  } catch (e) {
    const err = e as { code?: string };
    console.error('[guide/own/leads] отметка заявки не записана:', `sqlstate=${err?.code ?? 'нет'}`);
    return NextResponse.json({ success: false, error: 'Не удалось записать — попробуйте ещё раз' }, { status: 503 });
  }
}
