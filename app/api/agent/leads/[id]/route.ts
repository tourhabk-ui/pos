/**
 * PATCH /api/agent/leads/[id]  — обновить статус лида
 * Auth: admin (агентам закрыто 26.09 — ПД туристов, см. ниже)
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { requireAgent } from '@/lib/auth/middleware';
import { recordSourceEventQuietly, statusChangeTitle } from '@/lib/crm/events';
import { LEAD_CLIENT_CANCELLED } from '@/lib/types/statuses';
import { LEAD_CANCELLED_STATUS_TEXT } from '@/lib/leads/client-cancelled';

export const dynamic = 'force-dynamic';

const Schema = z.object({
  status: z.enum(['contacted', 'qualified', 'converted', 'lost']),
  notes:  z.string().max(1000).optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAgent(req);
  if (auth instanceof NextResponse) return auth;

  // Заявки платформы — ПД туристов (имя, телефон, комментарий). До 26.09 их
  // читал и правил любой аккаунт с ролью agent, а её выдаёт самостоятельная
  // регистрация: персональные данные всех туристов — любому, кто
  // зарегистрировался. Владения лидом у агента в схеме нет (leads.operator_id —
  // оператор), поэтому доступ закрыт целиком, пока не решено, какие лиды агенту
  // положены. Администратор работает с ними как раньше.
  if (auth.role !== 'admin') {
    return NextResponse.json(
      { success: false, error: 'Заявки платформы агентам недоступны' },
      { status: 403 },
    );
  }

  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 }); }

  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Некорректные данные', details: parsed.error.issues }, { status: 400 });
  }

  // Заявку, которую отменил клиент (1427), в работу не возвращают: условие — в самой записи.
  const result = await query<{ id: string; status: string; notes: string | null; prev_status: string | null }>(
    `WITH prev AS (SELECT status FROM leads WHERE id = $1)
     UPDATE leads SET status = $2, notes = COALESCE($3, notes), updated_at = NOW()
     WHERE id = $1 AND status <> $4 RETURNING id, status, notes, (SELECT status FROM prev) AS prev_status`,
    [params.id, parsed.data.status, parsed.data.notes ?? null, LEAD_CLIENT_CANCELLED]
  );

  if (result.rowCount === 0) {
    // Нет строки: лида нет — или его отменил клиент. Это разные ответы.
    const now = await query<{ status: string }>(`SELECT status FROM leads WHERE id = $1`, [params.id]);
    if (now.rows[0]?.status === LEAD_CLIENT_CANCELLED) {
      return NextResponse.json({ success: false, error: LEAD_CANCELLED_STATUS_TEXT }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: 'Лид не найден' }, { status: 404 });
  }

  const { prev_status: prevStatus, ...lead } = result.rows[0];
  if (prevStatus !== lead.status) {
    // Лента клиента оператора (CRM #2325): заявка привязана к оператору, и
    // смена статуса администратором — событие у него.
    await recordSourceEventQuietly({
      kind: 'status_change', sourceKind: 'lead', sourceId: params.id,
      actorKind: 'admin', actorUserId: auth.userId,
      title: statusChangeTitle('lead', prevStatus, lead.status),
      payload: { from: prevStatus, to: lead.status },
    });
  }

  return NextResponse.json({ success: true, data: lead });
}
