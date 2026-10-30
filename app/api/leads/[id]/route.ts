import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { requireAdmin, requireOperator } from '@/lib/auth/middleware';
import type { JWTPayload } from '@/lib/auth/jwt';
import { leadOwnershipCond, operatorLeadScope } from '@/lib/leads/ownership';
import { changeLeadStatus, LEAD_STATUSES } from '@/lib/leads/owner-lead-status';
import { bookingsForLead, type LeadBookings } from '@/lib/leads/lead-bookings';

const PatchSchema = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  notes: z.string().max(2000).optional(),
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

  const { status, notes } = parse.data;
  if (!status && notes === undefined) {
    return NextResponse.json({ error: 'Нечего обновлять' }, { status: 400 });
  }

  // Правило смены одно с разделом «Свои туры» гида (lib/leads/owner-lead-status).
  // Скоуп кабинета оператора: чужой лид не обновляется и неотличим от
  // несуществующего (404, не 403); первое действие над ничейным делает его
  // своим (25.09) — иначе два оператора звонили одному туристу и перетирали
  // заметки друг друга.
  const outcome = await changeLeadStatus({
    leadId: id,
    status,
    notes,
    actor: { kind: user.role === 'admin' ? 'admin' : 'partner_user', userId: user.userId },
    scope: await operatorLeadScope(user),
    via: 'site',
  });

  if (outcome.kind === 'not_found') {
    return NextResponse.json({ error: 'Лид не найден' }, { status: 404 });
  }

  return NextResponse.json({ success: true, lead: outcome.lead, changed: outcome.changed });
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
    lead: res.rows[0],
    bookings: bookings.kind === 'ok' ? bookings.rows : null,
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
