/**
 * PATCH /api/agent/leads/[id]  — обновить статус лида
 * Auth: admin (агентам закрыто 26.09 — ПД туристов, см. ниже)
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { requireAgent } from '@/lib/auth/middleware';

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

  const result = await query(
    `UPDATE leads SET status = $2, notes = COALESCE($3, notes), updated_at = NOW()
     WHERE id = $1 RETURNING id, status, notes`,
    [params.id, parsed.data.status, parsed.data.notes ?? null]
  );

  if (result.rowCount === 0) {
    return NextResponse.json({ success: false, error: 'Лид не найден' }, { status: 404 });
  }

  return NextResponse.json({ success: true, data: result.rows[0] });
}
