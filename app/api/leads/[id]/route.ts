import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { requireAdmin, requireOperator } from '@/lib/auth/middleware';
import type { JWTPayload } from '@/lib/auth/jwt';
import { leadOwnershipCond } from '@/lib/leads/ownership';

const PatchSchema = z.object({
  status: z.enum([
    'new',
    'ai_processing',
    'ai_qualified',
    'proposal_sent',
    'awaiting_confirm',
    'contacted',
    'qualified',
    'converted',
    'lost',
  ]).optional(),
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

  const sets: string[] = ['updated_at = NOW()'];
  const vals: unknown[] = [];
  let idx = 1;

  if (status) { sets.push(`status = $${idx++}`); vals.push(status); }
  if (notes !== undefined) { sets.push(`notes = $${idx++}`); vals.push(notes); }
  vals.push(id);

  // Чужой лид не обновляется и неотличим от несуществующего (404, не 403).
  const scope = await leadOwnershipCond(user, idx + 1);
  const res = await pool.query<{ id: string; status: string; notes: string | null }>(
    `UPDATE leads SET ${sets.join(', ')} WHERE id = $${idx}${scope.cond} RETURNING id, status, notes`,
    [...vals, ...scope.vals]
  );

  if (!res.rows.length) {
    return NextResponse.json({ error: 'Лид не найден' }, { status: 404 });
  }

  return NextResponse.json({ success: true, lead: res.rows[0] });
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
            created_at, updated_at
     FROM leads WHERE id = $1${scope.cond}`,
    [id, ...scope.vals]
  );

  if (!res.rows.length) {
    return NextResponse.json({ error: 'Лид не найден' }, { status: 404 });
  }

  return NextResponse.json({ lead: res.rows[0] });
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
