import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { requireAdmin, requireOperator } from '@/lib/auth/middleware';
import type { JWTPayload } from '@/lib/auth/jwt';
import { leadOwnershipCond, operatorLeadScope } from '@/lib/leads/ownership';
import { changeLeadStatus, LEAD_STATUSES } from '@/lib/leads/owner-lead-status';
import { bookingsForLead, type LeadBookings } from '@/lib/leads/lead-bookings';
import { withLeadOrigin, type LeadOriginInput } from '@/lib/leads/origin';
import { LEAD_CANCELLED_STATUS_TEXT } from '@/lib/leads/client-cancelled';
import { LEAD_CLIENT_CANCELLED } from '@/lib/types/statuses';
import {
  LOST_REASONS, LOST_REASON_ONLY_WITH_LOST, LOST_REASON_REQUIRED, LOST_REASON_SELLER_ONLY, LOST_REASON_UNKNOWN,
} from '@/lib/leads/lost-reason';
import { closeLeadWithReason } from '@/lib/leads/seller-lost-flow';

const PatchSchema = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  notes: z.string().max(2000).optional(),
  /** Причина отказа — вместе со `status: 'lost'` (этап 3а, lib/leads/lost-reason). */
  lostReason: z.enum(LOST_REASONS, { message: LOST_REASON_UNKNOWN }).optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireOperator(request);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult as JWTPayload;

  const { id } = await params;

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Неверный формат' }, { status: 400 });
  }

  const parse = PatchSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ error: parse.error.issues[0]?.message }, { status: 422 });
  }

  const { status, notes, lostReason } = parse.data;
  if (!status && notes === undefined) {
    return NextResponse.json({ error: 'Нечего обновлять' }, { status: 400 });
  }

  // Правило смены одно с разделом «Свои туры» гида (lib/leads/owner-lead-status).
  // Скоуп кабинета оператора: чужой лид не обновляется и неотличим от
  // несуществующего (404, не 403); первое действие над ничейным делает его
  // своим (25.09) — иначе два оператора звонили одному туристу и перетирали
  // заметки друг друга.
  const scope = await operatorLeadScope(user);
  const actor = { kind: user.role === 'admin' ? 'admin' as const : 'partner_user' as const, userId: user.userId };

  // «Отказ» продавца — только с причиной (этап 3а): от неё зависит, уйдёт ли
  // человеку сообщение. Администратор и оператор без карточки закрывают как
  // раньше: продавцом заявки они не являются, и сообщение «оператор отказал»
  // от них было бы неправдой.
  // Причина, которую некуда записать, не принимается молча (§4.0): с другой
  // отметкой и не от продавца — отказ словами, заявка не тронута.
  if (lostReason && status !== 'lost') {
    return NextResponse.json({ error: LOST_REASON_ONLY_WITH_LOST }, { status: 422 });
  }
  if (lostReason && scope.kind !== 'owner') {
    return NextResponse.json({ error: LOST_REASON_SELLER_ONLY }, { status: 422 });
  }
  let touristLine: string | null = null;
  let outcome;
  if (status === 'lost' && scope.kind === 'owner') {
    if (!lostReason) return NextResponse.json({ error: LOST_REASON_REQUIRED }, { status: 422 });
    const closed = await closeLeadWithReason({ leadId: id, reason: lostReason, notes, actor, scope, via: 'site' });
    outcome = closed.outcome;
    touristLine = closed.touristLine;
  } else {
    outcome = await changeLeadStatus({ leadId: id, status, notes, actor, scope, via: 'site' });
  }

  if (outcome.kind === 'not_found') {
    return NextResponse.json({ error: 'Лид не найден' }, { status: 404 });
  }
  // Заявку отменил клиент (1427): статус не сменён и не будет — ответить «изменён» было бы неправдой.
  // Заметка, присланная тем же запросом, записана: об этом сказано.
  if (status !== undefined && outcome.prevStatus === LEAD_CLIENT_CANCELLED) {
    return NextResponse.json(
      { error: notes !== undefined ? `${LEAD_CANCELLED_STATUS_TEXT}. Заметка сохранена.` : LEAD_CANCELLED_STATUS_TEXT, lead: outcome.lead },
      { status: 409 },
    );
  }

  // `tourist` — что на деле ушло человеку после отказа с причиной; null — отказ этим запросом не записан.
  return NextResponse.json({ success: true, lead: outcome.lead, changed: outcome.changed, tourist: touristLine });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireOperator(request);
  if (authResult instanceof NextResponse) return authResult;
  const user = authResult as JWTPayload;

  const { id } = await params;

  // Чужой лид не читается и неотличим от несуществующего (404, не 403).
  const scope = await leadOwnershipCond(user, 2);
  const res = await pool.query(
    `SELECT id, name, phone, email, comment, route_id, route_title, source_url, source_data,
            status, notes, proposal_id, ai_score, ai_summary, group_size, budget_rub, desired_dates,
            created_at, updated_at,
            -- Причина отказа продавца (1429); есть только у текущего закрытия.
            lost_reason,
            -- Только ради подписи «откуда» (lib/leads/origin), наружу не уходит.
            pd_consent_source,
            -- Есть ли куда отправлять предложение. Экран выключает кнопку
            -- заранее, а не узнаёт об этом из отказа сервера (#1804).
            (telegram_chat_id IS NOT NULL OR email IS NOT NULL) AS has_recipient
     FROM leads WHERE id = $1${scope.cond}`,
    [id, ...scope.vals]
  );

  if (!res.rows.length) {
    return NextResponse.json({ error: 'Лид не найден' }, { status: 404 });
  }

  // Брони, заведённые из лида (CRM фаза 2): оператору — только брони его
  // туров; оператор без записи партнёра своих туров не имеет — пусто.
  const operatorId = user.role === 'admin' ? null : (scope.vals[0] as string | undefined);
  const bookings: LeadBookings = user.role !== 'admin' && !operatorId
    ? { kind: 'ok', rows: [] }
    : await bookingsForLead(id, operatorId ?? null);

  return NextResponse.json({
    // Откуда заявка — одной подписью (слово владельца 08.11).
    lead: withLeadOrigin(res.rows[0] as LeadOriginInput & Record<string, unknown>),
    bookings: bookings.kind === 'ok' ? bookings.rows : null,
    // «Отказ» спрашивает причину только у продавца с карточкой (этап 3а):
    // экран узнаёт это заранее, а не из отказа сервера.
    lost_needs_reason: user.role !== 'admin' && !!operatorId,
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAdmin(request);
  if (authResult instanceof NextResponse) return authResult;

  const { id } = await params;

  const res = await pool.query<{ id: string }>(
    'DELETE FROM leads WHERE id = $1 RETURNING id',
    [id]
  );

  if (!res.rows.length) {
    return NextResponse.json({ error: 'Лид не найден' }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
