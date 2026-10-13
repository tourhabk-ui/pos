/**
 * Команда кабинета оператора (CRM фаза 2г, миграция 1223).
 *
 * GET  — менеджеры и ждущие ссылки;
 * POST — новая ссылка-приглашение: подпись и права менеджера. Ссылка
 *        возвращается ОДИН раз — в базе только хеш токена.
 *
 * Только владелец кабинета (requireOperatorOwner): состав команды — это
 * настройки, менеджеру они закрыты (решение владельца 11.10).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOperatorOwner } from '@/lib/operators/team-access';
import { createInvite, listTeam } from '@/lib/operators/team';
import { invitePath, MAX_PENDING_INVITES } from '@/lib/operators/team-invite';

export const dynamic = 'force-dynamic';

const InviteSchema = z.object({
  label: z.string().trim().max(100, 'Подпись не длиннее 100 символов').optional(),
  can_edit_prices: z.boolean().default(false),
  can_cancel_bookings: z.boolean().default(false),
});

function dbFailure(where: string, err: unknown): NextResponse {
  const code = (err as { code?: string } | null)?.code ?? '?';
  console.error(`[hub/operator/team] ${where} (SQLSTATE ${code}):`, err instanceof Error ? err.message : err);
  return NextResponse.json({ success: false, error: 'Команда не прочитана и не изменена: база не ответила. Попробуйте позже.' }, { status: 503 });
}

export async function GET(request: NextRequest) {
  const ctx = await requireOperatorOwner(request);
  if (ctx instanceof NextResponse) return ctx;
  try {
    return NextResponse.json({ success: true, data: { members: await listTeam(ctx.partnerId) } });
  } catch (err) {
    return dbFailure('чтение', err);
  }
}

export async function POST(request: NextRequest) {
  const ctx = await requireOperatorOwner(request);
  if (ctx instanceof NextResponse) return ctx;
  const parsed = InviteSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Неверные данные' }, { status: 400 });
  }
  try {
    const res = await createInvite({
      partnerId: ctx.partnerId,
      invitedBy: ctx.userId,
      label: parsed.data.label || null,
      perms: { can_edit_prices: parsed.data.can_edit_prices, can_cancel_bookings: parsed.data.can_cancel_bookings },
    });
    if (res.outcome === 'too_many') {
      return NextResponse.json(
        { success: false, error: `Ждущих ссылок уже ${MAX_PENDING_INVITES} — отзовите ненужные` },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { success: true, data: { member: res.member, path: invitePath(res.token) } },
      { status: 201 },
    );
  } catch (err) {
    return dbFailure('приглашение', err);
  }
}
