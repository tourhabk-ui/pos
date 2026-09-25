import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, transaction } from '@/lib/database';
import { ApiResponse } from '@/types';
import { getGuidePartnerId } from '@/lib/auth/guide-helpers';
import { requireRole } from '@/lib/auth/middleware';
import { TEAM_SQL } from '@/lib/guides/team-queries';
import { logGuideFailure } from '@/lib/guides/team';

export const dynamic = 'force-dynamic';

/**
 * Команда оператора — сторона гида (миграция 1018).
 *
 *   GET    — оператор, в команде которого гид, и ждущие ответа приглашения;
 *   POST   — { inviteId, action: 'accept' | 'decline' } — ответ на приглашение;
 *   DELETE — выйти из команды.
 *
 * Принятие — единственный писатель partners.guide_operator_id. Гид ведёт
 * одного оператора за раз: принять второе приглашение, не выйдя из первой
 * команды, нельзя — это сказано гиду словами (409), а не спрятано.
 */

const RespondSchema = z.object({
  inviteId: z.string().uuid('Некорректное приглашение'),
  action: z.enum(['accept', 'decline']),
});

async function guideFrom(request: NextRequest): Promise<string | NextResponse> {
  const auth = await requireRole(request, ['guide', 'admin']);
  if (auth instanceof NextResponse) return auth;
  const guideId = await getGuidePartnerId(auth.userId);
  if (!guideId) {
    return NextResponse.json(
      { success: false, error: 'Профиль гида не найден' } as ApiResponse<null>,
      { status: 404 },
    );
  }
  return guideId;
}

export async function GET(request: NextRequest) {
  const guideId = await guideFrom(request);
  if (guideId instanceof NextResponse) return guideId;

  try {
    const [membership, invites] = await Promise.all([
      query<{ operator_id: string | null; operator_name: string | null; operator_phone: string | null }>(
        TEAM_SQL.membership, [guideId],
      ),
      query<{ id: string; operator_id: string; operator_name: string | null; created_at: string }>(
        TEAM_SQL.pendingInvitesForGuide, [guideId],
      ),
    ]);
    const m = membership.rows[0];
    return NextResponse.json({
      success: true,
      data: {
        operator: m?.operator_id
          ? { id: m.operator_id, name: m.operator_name, phone: m.operator_phone }
          : null,
        invites: invites.rows.map((r) => ({
          id: r.id,
          operatorId: r.operator_id,
          operatorName: r.operator_name,
          createdAt: r.created_at,
        })),
      },
    } as ApiResponse<unknown>);
  } catch (error) {
    logGuideFailure('guide.team.get', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить приглашения. Попробуйте обновить страницу.' } as ApiResponse<null>,
      { status: 500 },
    );
  }
}

type RespondOutcome = 'ok' | 'not_found' | 'other_team';

export async function POST(request: NextRequest) {
  const guideId = await guideFrom(request);
  if (guideId instanceof NextResponse) return guideId;

  const parsed = RespondSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' } as ApiResponse<null>,
      { status: 400 },
    );
  }
  const { inviteId, action } = parsed.data;

  try {
    const outcome = await transaction<RespondOutcome>(async (client) => {
      // Порядок блокировок один на все пути: сначала гид, потом приглашение.
      const guide = await client.query<{ guide_operator_id: string | null }>(TEAM_SQL.lockGuide, [guideId]);
      const invite = await client.query<{ id: string; operator_id: string }>(
        TEAM_SQL.lockPendingInviteForGuide, [inviteId, guideId],
      );
      if (invite.rows.length === 0 || guide.rows.length === 0) return 'not_found';

      if (action === 'decline') {
        await client.query(TEAM_SQL.respondInvite, [inviteId, 'declined']);
        return 'ok';
      }

      const current = guide.rows[0].guide_operator_id;
      const target = invite.rows[0].operator_id;
      if (current && current !== target) return 'other_team';
      if (!current) await client.query(TEAM_SQL.setMembership, [guideId, target]);
      await client.query(TEAM_SQL.respondInvite, [inviteId, 'accepted']);
      return 'ok';
    });

    if (outcome === 'not_found') {
      return NextResponse.json(
        { success: false, error: 'Приглашение не найдено или уже закрыто' } as ApiResponse<null>,
        { status: 404 },
      );
    }
    if (outcome === 'other_team') {
      return NextResponse.json(
        { success: false, error: 'Вы уже в команде другого оператора. Чтобы принять это приглашение, сначала выйдите из текущей команды.' } as ApiResponse<null>,
        { status: 409 },
      );
    }
    return NextResponse.json({
      success: true,
      message: action === 'accept' ? 'Вы в команде оператора' : 'Приглашение отклонено',
    } as ApiResponse<null>);
  } catch (error) {
    logGuideFailure('guide.team.respond', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось ответить на приглашение. Попробуйте ещё раз.' } as ApiResponse<null>,
      { status: 500 },
    );
  }
}

/** DELETE — выйти из команды: членство снимается, будущие назначения снимаются. */
export async function DELETE(request: NextRequest) {
  const guideId = await guideFrom(request);
  if (guideId instanceof NextResponse) return guideId;

  try {
    const left = await transaction<boolean>(async (client) => {
      const guide = await client.query<{ guide_operator_id: string | null }>(TEAM_SQL.lockGuide, [guideId]);
      const operatorId = guide.rows[0]?.guide_operator_id;
      if (!operatorId) return false;
      await client.query(TEAM_SQL.clearMembership, [guideId, operatorId]);
      await client.query(TEAM_SQL.closeAcceptedInvites, [guideId, operatorId, 'left']);
      await client.query(TEAM_SQL.unassignFutureBookings, [guideId, operatorId]);
      return true;
    });
    if (!left) {
      return NextResponse.json(
        { success: false, error: 'Вы не состоите в команде оператора' } as ApiResponse<null>,
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true, message: 'Вы вышли из команды оператора' } as ApiResponse<null>);
  } catch (error) {
    logGuideFailure('guide.team.leave', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось выйти из команды. Попробуйте ещё раз.' } as ApiResponse<null>,
      { status: 500 },
    );
  }
}
