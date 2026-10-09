/**
 * PUT /api/agent/clients/[id] — правка карточки клиента агента.
 *
 * Форма «Изменить» в кабинете (ClientFormModal) звала этот адрес давно, а
 * роута не было: правка отвечала 404, и телефон, без которого бронь за
 * клиента не заводится, исправить было нечем (аудит 26.09). Править может
 * только одобренный агент и только СВОЕГО клиента.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { requireApprovedAgent } from '@/lib/auth/agent-approval';
import {
  ClientFieldsSchema, CLIENT_PHONE_MESSAGE, clientPhone, sqlstateOf,
} from '@/lib/agent-cabinet/client-fields';
import { recordSourceEventQuietly, statusChangeTitle } from '@/lib/crm/events';

export const dynamic = 'force-dynamic';

const IdSchema = z.string().uuid();

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireApprovedAgent(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await context.params;
  if (!IdSchema.safeParse(id).success) {
    return NextResponse.json({ success: false, error: 'Клиент не найден' }, { status: 404 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }
  const parsed = ClientFieldsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 },
    );
  }
  const f = parsed.data;
  const phone = clientPhone(f.phone);
  if (!phone) {
    return NextResponse.json({ success: false, error: CLIENT_PHONE_MESSAGE }, { status: 400 });
  }

  try {
    const { rows } = await pool.query<{ prev_status: string | null }>(
      `WITH prev AS (SELECT status FROM agent_clients WHERE id = $1 AND agent_id = $2)
       UPDATE agent_clients
          SET name = $3, email = $4, phone = $5, company = $6, status = $7,
              notes = $8, tags = $9::jsonb, source = $10, updated_at = NOW()
        WHERE id = $1 AND agent_id = $2
        RETURNING (SELECT status FROM prev) AS prev_status`,
      [id, auth.userId, f.name, f.email ? f.email : null, phone, f.company || null,
        f.status, f.notes || null, JSON.stringify(f.tags), f.source],
    );
    if (rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Клиент не найден среди ваших клиентов' }, { status: 404 });
    }
    const prevStatus = rows[0].prev_status;
    if (prevStatus !== f.status) {
      // Лента клиента агента (CRM #2325) — только смена статуса; правка
      // имени и телефона событием не является.
      await recordSourceEventQuietly({
        kind: 'status_change', sourceKind: 'agent_client', sourceId: id,
        actorKind: 'partner_user', actorUserId: auth.userId,
        title: statusChangeTitle('agent_client', prevStatus, f.status),
        payload: { from: prevStatus, to: f.status },
      });
    }
    return NextResponse.json({ success: true, message: 'Клиент сохранён' });
  } catch (err) {
    console.error(`[agent/clients/${id}] клиент не сохранён, SQLSTATE ${sqlstateOf(err)}:`,
      err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, error: 'Не удалось сохранить клиента. Попробуйте позже.' },
      { status: 500 },
    );
  }
}
