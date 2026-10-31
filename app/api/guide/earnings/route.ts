import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ApiResponse } from '@/types';
import { requireRole } from '@/lib/auth/middleware';
import { getGuidePartnerId } from '@/lib/auth/guide-helpers';
import { logGuideFailure } from '@/lib/guides/db-failure';
import { EARNINGS_PERIODS, readGuideEarnings } from '@/lib/guides/earnings-read';

export const dynamic = 'force-dynamic';

/**
 * GET /api/guide/earnings?period=week|month|year|all — начисления гиду.
 *
 * Прежняя версия не выполнялась НИКОГДА и не могла ничего найти:
 *   - `guide_earnings.tour_id` (uuid, ссылка на легаси `tours`) соединялся с
 *     `operator_tours.id` (bigint) — 42883 на разборе;
 *   - `WHERE ge.guide_id = <users.id>`, хотя внешний ключ — `partners.id`;
 *   - отдавала `{earnings, stats}`, а экран ждал `{summary, items}` и
 *     молча рисовал «0 ₽»; `?period` не читался;
 *   - в «Всего заработано» шли и отменённые начисления, а средняя ставка
 *     комиссии без строк подменялась выдуманными 10%.
 *
 * Писателя `guide_earnings` в коде нет (см. lib/auth/guide-helpers.ts: он
 * проектируется вместе с выплатой, это решение владельца). Поэтому пустой
 * ответ здесь — обычное состояние, и итоги при нуле строк — `null`
 * («начислений не было»), а не 0 ₽.
 */

const QuerySchema = z.object({
  period: z.enum(EARNINGS_PERIODS).default('month'),
});

export async function GET(request: NextRequest) {
  const guideOrResponse = await requireRole(request, ['guide', 'admin']);
  if (guideOrResponse instanceof NextResponse) return guideOrResponse;

  const parsed = QuerySchema.safeParse({ period: request.nextUrl.searchParams.get('period') ?? undefined });
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Неизвестный период' } as ApiResponse<null>, { status: 400 });
  }

  try {
    const guideId = await getGuidePartnerId(guideOrResponse.userId);
    if (!guideId) {
      return NextResponse.json({ success: false, error: 'Профиль гида не найден' } as ApiResponse<null>, { status: 404 });
    }
    // То же чтение, что экран «Заработок» в чате кабинета (lib/guides/earnings-read).
    const data = await readGuideEarnings(guideId, parsed.data.period);
    return NextResponse.json({ success: true, data } as ApiResponse<unknown>);
  } catch (error) {
    logGuideFailure('GET /api/guide/earnings', error);
    return NextResponse.json({ success: false, error: 'Ошибка при получении начислений' } as ApiResponse<null>, { status: 500 });
  }
}
