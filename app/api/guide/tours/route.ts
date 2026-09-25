import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { getGuidePartnerId } from '@/lib/auth/guide-helpers';
import { requireRole } from '@/lib/auth/middleware';
import { TEAM_SQL } from '@/lib/guides/team-queries';
import { logGuideFailure } from '@/lib/guides/team';

export const dynamic = 'force-dynamic';

/**
 * GET /api/guide/tours — «Мои туры» гида.
 *
 * Туры — ТОЛЬКО туры оператора, в команде которого гид состоит
 * (partners.guide_operator_id; пишет принятие приглашения, миграция 1018),
 * и у каждого — сколько предстоящих броней этого тура назначено гиду.
 *
 * До 25.09 здесь было три дефекта разом: приведение id оператора к bigint при
 * uuid-колонке оператора (42883 → 500 на КАЖДОМ запросе привязанного гида),
 * несуществующие колонки «гид включён»/«снаряжение включено», а у непривязанного гида
 * «Мои туры» показывали ВСЕ туры платформы. Теперь нет команды — честное
 * `operator: null` и пустой список: «вы пока не в команде оператора».
 */
interface MembershipRow { operator_id: string | null; operator_name: string | null; operator_phone: string | null }
interface TourRow {
  id: string; title: string; slug: string | null; description: string | null;
  activity_type: string | null; duration_hours: string | null; base_price: string | null;
  max_participants: number | null; future_slots: number; my_assignments: number;
}

function num(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function GET(request: NextRequest) {
  const userOrResponse = await requireRole(request, ['guide', 'admin']);
  if (userOrResponse instanceof NextResponse) return userOrResponse;

  const guideId = await getGuidePartnerId(userOrResponse.userId);
  if (!guideId) {
    return NextResponse.json(
      { success: false, error: 'Профиль гида не найден' } as ApiResponse<null>,
      { status: 404 },
    );
  }

  try {
    const membership = await query<MembershipRow>(TEAM_SQL.membership, [guideId]);
    const m = membership.rows[0];
    if (!m?.operator_id) {
      return NextResponse.json({
        success: true,
        data: { operator: null, tours: [] },
      } as ApiResponse<unknown>);
    }

    const result = await query<TourRow>(TEAM_SQL.operatorTours, [m.operator_id, guideId]);
    return NextResponse.json({
      success: true,
      data: {
        operator: { id: m.operator_id, name: m.operator_name, phone: m.operator_phone },
        tours: result.rows.map((r) => ({
          id: r.id,
          title: r.title,
          slug: r.slug,
          description: r.description,
          activityType: r.activity_type,
          durationHours: num(r.duration_hours),
          basePrice: num(r.base_price),
          maxParticipants: r.max_participants,
          futureSlots: Number(r.future_slots),
          myAssignments: Number(r.my_assignments),
        })),
      },
    } as ApiResponse<unknown>);
  } catch (error) {
    logGuideFailure('guide.tours', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить туры. Попробуйте обновить страницу.' } as ApiResponse<null>,
      { status: 500 },
    );
  }
}
