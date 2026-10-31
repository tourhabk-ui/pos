import { NextRequest, NextResponse } from 'next/server';
import { ApiResponse } from '@/types';
import { getGuidePartnerId } from '@/lib/auth/guide-helpers';
import { requireRole } from '@/lib/auth/middleware';
import { logGuideFailure } from '@/lib/guides/team';
import { readGuideGroups } from '@/lib/guides/schedule-read';

export const dynamic = 'force-dynamic';

/**
 * GET /api/guide/groups — группы гида = предстоящие брони, на которые его
 * назначил оператор (operator_bookings.guide_partner_id, миграция 1018),
 * сгруппированные по дате и туру.
 *
 * До 25.09 группы жили в guide_groups, привязанной к расписанию: соединение
 * расписания с operator_tours (uuid = bigint) отвечало 500 всегда, а участников в
 * guide_groups.participants не писал никто — группа могла быть только пустой.
 * Теперь участники и контакт туриста берутся из самой брони. Имя и телефон —
 * ПД: запрос отдаёт их только назначенному гиду, пока он в команде оператора
 * брони (правило — в SQL, lib/guides/team-queries.ts). Создавать группу руками
 * больше нечем и незачем: её делает назначение.
 */
export async function GET(request: NextRequest) {
  const guideOrResponse = await requireRole(request, ['guide', 'admin']);
  if (guideOrResponse instanceof NextResponse) return guideOrResponse;

  const guideId = await getGuidePartnerId(guideOrResponse.userId);
  if (!guideId) {
    return NextResponse.json(
      { success: false, error: 'Профиль гида не найден' } as ApiResponse<null>,
      { status: 404 },
    );
  }

  try {
    // То же чтение, что экран «Расписание» в чате кабинета (lib/guides/schedule-read).
    const data = await readGuideGroups(guideId);
    return NextResponse.json({ success: true, data } as ApiResponse<unknown>);
  } catch (error) {
    logGuideFailure('guide.groups', error);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить группы. Попробуйте обновить страницу.' } as ApiResponse<null>,
      { status: 500 },
    );
  }
}
