/**
 * PUT /api/hub/operator/bookings/[id]/guide — назначить гида на бронь или снять.
 *
 * Тело: { guidePartnerId: uuid | null }. Пишет operator_bookings.guide_partner_id
 * (миграция 1018) — единственный писатель этой колонки, кроме снятия при
 * исключении/выходе гида из команды.
 *
 * Правила (оба — условиями SQL под блокировкой строки брони):
 *   * бронь принадлежит оператору — через тур (operator_tours.operator_id);
 *     чужая бронь неотличима от несуществующей (404);
 *   * гид состоит в команде ЭТОГО оператора (partners.guide_operator_id) —
 *     гид чужой команды или бывший член — 409, не назначается.
 * Закрытую бронь (завершена/отменена/неявка) не переназначают: гид в ней уже
 * был или не будет, и правка истории задним числом — не назначение.
 *
 * Назначенный гид получает уведомление в кабинет — без ПД туриста (тур и дата);
 * имя и телефон туриста он видит на своей странице «Группы».
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOperator } from '@/lib/auth/middleware';
import { transaction } from '@/lib/database';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';
import type { ApiResponse } from '@/types';
import { TEAM_SQL } from '@/lib/guides/team-queries';
import { BIGINT_RE, logGuideFailure, notifyUser } from '@/lib/guides/team';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  guidePartnerId: z.string().uuid('Некорректный гид').nullable(),
});

const CLOSED = new Set(['completed', 'cancelled', 'no_show', 'rejected']);

type Outcome =
  | { kind: 'not_found' }
  | { kind: 'closed' }
  | { kind: 'not_member' }
  | { kind: 'ok'; guideUserId: string | null; tourTitle: string; date: string; changed: boolean };

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await requireOperator(request);
  if (auth instanceof NextResponse) return auth;

  const operatorId = await getOperatorPartnerId(auth.userId);
  if (!operatorId) {
    return NextResponse.json(
      { success: false, error: 'Профиль оператора не найден' } as ApiResponse<null>,
      { status: 403 },
    );
  }
  if (!BIGINT_RE.test(id)) {
    return NextResponse.json(
      { success: false, error: 'Бронь не найдена' } as ApiResponse<null>,
      { status: 404 },
    );
  }

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' } as ApiResponse<null>,
      { status: 400 },
    );
  }
  const guideId = parsed.data.guidePartnerId;

  try {
    const outcome = await transaction<Outcome>(async (client) => {
      const booking = await client.query<{
        id: string; guide_partner_id: string | null; booking_status: string;
        booking_date: string; tour_title: string;
      }>(TEAM_SQL.lockOperatorBooking, [id, operatorId]);
      const b = booking.rows[0];
      if (!b) return { kind: 'not_found' };
      if (CLOSED.has(b.booking_status)) return { kind: 'closed' };

      let guideUserId: string | null = null;
      if (guideId) {
        const member = await client.query<{ id: string; user_id: string | null }>(
          TEAM_SQL.teamGuide, [guideId, operatorId],
        );
        if (member.rows.length === 0) return { kind: 'not_member' };
        guideUserId = member.rows[0].user_id;
      }

      const changed = b.guide_partner_id !== guideId;
      if (changed) await client.query(TEAM_SQL.setBookingGuide, [id, guideId]);
      return { kind: 'ok', guideUserId, tourTitle: b.tour_title, date: b.booking_date, changed };
    });

    if (outcome.kind === 'not_found') {
      return NextResponse.json({ success: false, error: 'Бронь не найдена' } as ApiResponse<null>, { status: 404 });
    }
    if (outcome.kind === 'closed') {
      return NextResponse.json(
        { success: false, error: 'Бронь закрыта — гида на неё не назначают' } as ApiResponse<null>,
        { status: 409 },
      );
    }
    if (outcome.kind === 'not_member') {
      return NextResponse.json(
        { success: false, error: 'Этот гид не состоит в вашей команде' } as ApiResponse<null>,
        { status: 409 },
      );
    }

    if (guideId && outcome.changed) {
      await notifyUser({
        userId: outcome.guideUserId,
        type: 'guide_assignment',
        title: 'Вас назначили на тур',
        message: `${outcome.tourTitle}, ${outcome.date}. Состав группы и контакт — в разделе «Группы».`,
        data: { bookingId: id },
        actionUrl: '/hub/guide/groups',
      });
    }

    return NextResponse.json({
      success: true,
      data: { bookingId: id, guidePartnerId: guideId },
      message: guideId ? 'Гид назначен' : 'Гид снят с брони',
    } as ApiResponse<unknown>);
  } catch (error) {
    logGuideFailure('operator.booking.assignGuide', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось назначить гида. Попробуйте ещё раз.' } as ApiResponse<null>,
      { status: 500 },
    );
  }
}
