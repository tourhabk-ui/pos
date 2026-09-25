/**
 * Приглашения гидов в команду оператора (миграция 1018).
 *
 *   GET    — ждущие и недавние приглашения оператора;
 *   POST   — { email } — пригласить гида по e-mail его аккаунта;
 *   DELETE — { inviteId } — отозвать ждущее приглашение.
 *
 * Гид отвечает в своём кабинете (/api/guide/team). До этого у
 * partners.guide_operator_id не было ни одного писателя, и экран «Гиды»
 * оператора был пуст по построению.
 *
 * Роль: operator (или admin с партнёрским профилем оператора). Оператор видит
 * и отзывает ТОЛЬКО свои приглашения — условие по operator_id в SQL.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { requireRole } from '@/lib/auth/middleware';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';
import type { ApiResponse } from '@/types';
import { TEAM_SQL } from '@/lib/guides/team-queries';
import { logGuideFailure, notifyUser, INVITE_STATUSES, type InviteStatus } from '@/lib/guides/team';

export const dynamic = 'force-dynamic';

const InviteSchema = z.object({
  email: z.string().trim().email('Укажите e-mail аккаунта гида').max(255),
});
const RevokeSchema = z.object({
  inviteId: z.string().uuid('Некорректное приглашение'),
});

async function operatorFrom(request: NextRequest): Promise<{ operatorId: string; userId: string } | NextResponse> {
  const auth = await requireRole(request, ['operator', 'admin']);
  if (auth instanceof NextResponse) return auth;
  const operatorId = await getOperatorPartnerId(auth.userId);
  if (!operatorId) {
    return NextResponse.json(
      { success: false, error: 'Профиль оператора не найден' } as ApiResponse<null>,
      { status: 404 },
    );
  }
  return { operatorId, userId: auth.userId };
}

function isInviteStatus(v: string): v is InviteStatus {
  return (INVITE_STATUSES as readonly string[]).includes(v);
}

export async function GET(request: NextRequest) {
  const ctx = await operatorFrom(request);
  if (ctx instanceof NextResponse) return ctx;

  try {
    const { rows } = await query<{
      id: string; status: string; created_at: string; responded_at: string | null;
      guide_id: string; guide_name: string | null;
    }>(TEAM_SQL.operatorInvites, [ctx.operatorId]);
    return NextResponse.json({
      success: true,
      data: rows.filter((r) => isInviteStatus(r.status)).map((r) => ({
        id: r.id,
        status: r.status,
        guideId: r.guide_id,
        guideName: r.guide_name ?? 'Без имени',
        createdAt: r.created_at,
        respondedAt: r.responded_at,
      })),
    } as ApiResponse<unknown>);
  } catch (error) {
    logGuideFailure('operator.invites.get', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить приглашения. Попробуйте обновить страницу.' } as ApiResponse<null>,
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const ctx = await operatorFrom(request);
  if (ctx instanceof NextResponse) return ctx;

  const parsed = InviteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' } as ApiResponse<null>,
      { status: 400 },
    );
  }

  try {
    const found = await query<{ id: string; name: string | null; user_id: string | null; guide_operator_id: string | null }>(
      TEAM_SQL.findGuideByEmail, [parsed.data.email],
    );
    const guide = found.rows[0];
    if (!guide) {
      return NextResponse.json(
        { success: false, error: 'Гид с таким e-mail не зарегистрирован. Попросите его завести кабинет гида на платформе.' } as ApiResponse<null>,
        { status: 404 },
      );
    }
    if (guide.guide_operator_id === ctx.operatorId) {
      return NextResponse.json(
        { success: false, error: 'Этот гид уже в вашей команде' } as ApiResponse<null>,
        { status: 409 },
      );
    }

    const inserted = await query<{ id: string }>(TEAM_SQL.insertInvite, [ctx.operatorId, guide.id, ctx.userId]);
    if (inserted.rows.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Приглашение этому гиду уже отправлено и ждёт ответа' } as ApiResponse<null>,
        { status: 409 },
      );
    }

    await notifyUser({
      userId: guide.user_id,
      type: 'guide_invite',
      title: 'Приглашение в команду оператора',
      message: 'Оператор приглашает вас в свою команду. Ответить можно в кабинете гида.',
      data: { inviteId: inserted.rows[0].id, operatorId: ctx.operatorId },
      actionUrl: '/hub/guide',
    });

    return NextResponse.json({
      success: true,
      data: { id: inserted.rows[0].id, guideName: guide.name ?? 'Без имени' },
      message: 'Приглашение отправлено',
    } as ApiResponse<unknown>);
  } catch (error) {
    logGuideFailure('operator.invites.create', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось отправить приглашение. Попробуйте ещё раз.' } as ApiResponse<null>,
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const ctx = await operatorFrom(request);
  if (ctx instanceof NextResponse) return ctx;

  const parsed = RevokeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' } as ApiResponse<null>,
      { status: 400 },
    );
  }

  try {
    const { rows } = await query<{ id: string }>(TEAM_SQL.revokeInvite, [parsed.data.inviteId, ctx.operatorId]);
    if (rows.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Ждущее приглашение не найдено среди ваших' } as ApiResponse<null>,
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true, message: 'Приглашение отозвано' } as ApiResponse<null>);
  } catch (error) {
    logGuideFailure('operator.invites.revoke', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось отозвать приглашение. Попробуйте ещё раз.' } as ApiResponse<null>,
      { status: 500 },
    );
  }
}
