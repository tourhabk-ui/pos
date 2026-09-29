/**
 * GET /api/admin/analytics/funnel-window — воронка за день / вчера / 7 / 30
 * суток или за любые прошлые сутки, плюс разбивка шагов по суткам.
 *
 * Владелец 29.09: «хочу смотреть не только аналитику за 7 дней, но и за
 * день». Считает `lib/analytics/funnel-window` — тот же модуль, что у
 * крон-переписи `/api/cron/funnel-census`, поэтому цифры страницы и цифры,
 * которые читает эволюция, не могут разойтись.
 *
 * Параметры (нужно не больше одного): `range` = today | yesterday | 7d | 30d,
 * либо `date` = ГГГГ-ММ-ДД (сутки по Камчатке). Без параметров — сегодня.
 *
 * Сутки — камчатские (UTC+12), а не сервера и не базы: день человека не
 * должен делиться пополам чужой полуночью.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { safeMsg } from '@/lib/errors/sanitize';
import {
  FUNNEL_RANGES,
  buildFunnelReport,
  funnelByDay,
  resolveFunnelWindow,
  DEFAULT_DAILY_ROWS,
} from '@/lib/analytics/funnel-window';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  range: z.enum(FUNNEL_RANGES, { message: `Неизвестный период. Допустимы: ${FUNNEL_RANGES.join(', ')}.` }).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата — в формате ГГГГ-ММ-ДД').optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const q = request.nextUrl.searchParams;
  const parsed = QuerySchema.safeParse({
    range: q.get('range') ?? undefined,
    date: q.get('date') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Неверные параметры периода' },
      { status: 400 },
    );
  }

  const now = new Date();
  const { range, date } = parsed.data;
  // Ничего не выбрано — сегодня: страница открывается на «сегодня».
  const resolved = resolveFunnelWindow({ range: range ?? (date ? undefined : 'today'), date }, now);
  if (!resolved.ok) {
    return NextResponse.json({ success: false, error: resolved.error }, { status: 400 });
  }

  try {
    const [report, daily] = await Promise.all([
      buildFunnelReport(resolved.window),
      funnelByDay(now, DEFAULT_DAILY_ROWS),
    ]);
    return NextResponse.json({
      success: true,
      data: { generated_at: now.toISOString(), report, daily: daily.rows, daily_failed: daily.failed },
    });
  } catch (e) {
    console.error('[admin/funnel-window] не удалось построить воронку:', e instanceof Error ? e.message : e);
    return NextResponse.json(
      { success: false, error: safeMsg(e, 'Не удалось прочитать воронку') },
      { status: 500 },
    );
  }
}
