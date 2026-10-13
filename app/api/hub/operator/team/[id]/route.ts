/**
 * Менеджер команды оператора (CRM фаза 2г, миграция 1223).
 *
 * PATCH  — права (цены, отмена броней) и подпись;
 * DELETE — снять менеджера или отозвать ждущую ссылку. Доступ закрывается
 *          сразу: резолвер кабинета спрашивает базу на каждом запросе.
 *
 * Только владелец кабинета (requireOperatorOwner). Чужой менеджер
 * неотличим от несуществующего (404): условие по partner_id в SQL.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOperatorOwner } from '@/lib/operators/team-access';
import { revokeMember, updateMember } from '@/lib/operators/team';

export const dynamic = 'force-dynamic';

const PatchSchema = z.object({
  label: z.string().trim().max(100, 'Подпись не длиннее 100 символов').nullable().optional(),
  can_edit_prices: z.boolean().optional(),
  can_cancel_bookings: z.boolean().optional(),
}).refine(v => v.label !== undefined || v.can_edit_prices !== undefined || v.can_cancel_bookings !== undefined, {
  message: 'Нечего менять',
});

const idSchema = z.string().uuid();

function dbFailure(where: string, err: unknown): NextResponse {
  const code = (err as { code?: string } | null)?.code ?? '?';
  console.error(`[hub/operator/team/id] ${where} (SQLSTATE ${code}):`, err instanceof Error ? err.message : err);
  return NextResponse.json({ success: false, error: 'Команда не изменена: база не ответила. Попробуйте позже.' }, { status: 503 });
}

const notFound = () => NextResponse.json({ success: false, error: 'Менеджер не найден или уже снят' }, { status: 404 });

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireOperatorOwner(request);
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return notFound();
  const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Неверные данные' }, { status: 400 });
  }
  try {
    const member = await updateMember(ctx.partnerId, id, {
      ...(parsed.data.label !== undefined ? { label: parsed.data.label || null } : {}),
      can_edit_prices: parsed.data.can_edit_prices,
      can_cancel_bookings: parsed.data.can_cancel_bookings,
    });
    return member ? NextResponse.json({ success: true, data: { member } }) : notFound();
  } catch (err) {
    return dbFailure('права', err);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireOperatorOwner(request);
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;
  if (!idSchema.safeParse(id).success) return notFound();
  try {
    const member = await revokeMember(ctx.partnerId, id, ctx.userId);
    return member ? NextResponse.json({ success: true, data: { member } }) : notFound();
  } catch (err) {
    return dbFailure('снятие', err);
  }
}
