import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiResponse } from '@/types';
import { getGuidePartnerId } from '@/lib/auth/guide-helpers';
import { requireRole } from '@/lib/auth/middleware';
import { leaveGuideTeam, readGuideTeam, respondGuideInvite } from '@/lib/guides/team-actions';
import { logGuideFailure } from '@/lib/guides/team';

export const dynamic = 'force-dynamic';

/**
 * Команда оператора — сторона гида (миграция 1018).
 *
 *   GET    — оператор, в команде которого гид, и ждущие ответа приглашения;
 *   POST   — { inviteId, action: 'accept' | 'decline' } — ответ на приглашение;
 *   DELETE — выйти из команды.
 *
 * Шаги записи — lib/guides/team-actions (их же зовёт чат кабинета).
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
    const team = await readGuideTeam(guideId);
    return NextResponse.json({ success: true, data: team } as ApiResponse<unknown>);
  } catch (error) {
    logGuideFailure('guide.team.get', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить приглашения. Попробуйте обновить страницу.' } as ApiResponse<null>,
      { status: 500 },
    );
  }
}

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
    // Та же функция, что кнопки «Принять» / «Отклонить» в чате кабинета.
    const outcome = await respondGuideInvite(guideId, inviteId, action);

    if (outcome.kind === 'not_found') {
      return NextResponse.json(
        { success: false, error: 'Приглашение не найдено или уже закрыто' } as ApiResponse<null>,
        { status: 404 },
      );
    }
    if (outcome.kind === 'other_team') {
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
    // Та же функция, что «Выйти из команды» в чате кабинета.
    const left = await leaveGuideTeam(guideId);
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
