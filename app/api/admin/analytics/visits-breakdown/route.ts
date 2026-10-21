/**
 * GET /api/admin/analytics/visits-breakdown — расширенная статистика визитов
 * за то же окно, что у воронки (`range` = today | yesterday | 7d | 30d либо
 * `date` = ГГГГ-ММ-ДД, сутки по Камчатке): источники, страницы входа,
 * устройства. Владелец 21.10: «круто бы при нажатии на количество визитов
 * открывалась бы расширенная статистика».
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { safeMsg } from '@/lib/errors/sanitize';
import { FUNNEL_RANGES, resolveFunnelWindow } from '@/lib/analytics/funnel-window';
import { buildVisitBreakdown } from '@/lib/analytics/visit-sources';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  range: z.enum(FUNNEL_RANGES, { message: `Неизвестный период. Допустимы: ${FUNNEL_RANGES.join(', ')}.` }).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата — в формате ГГГГ-ММ-ДД').optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const q = request.nextUrl.searchParams;
  const parsed = QuerySchema.safeParse({ range: q.get('range') ?? undefined, date: q.get('date') ?? undefined });
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Неверные параметры периода' }, { status: 400 });
  }
  const now = new Date();
  const { range, date } = parsed.data;
  const resolved = resolveFunnelWindow({ range: range ?? (date ? undefined : 'today'), date }, now);
  if (!resolved.ok) return NextResponse.json({ success: false, error: resolved.error }, { status: 400 });

  try {
    const breakdown = await buildVisitBreakdown(resolved.window);
    return NextResponse.json({
      success: true,
      data: {
        generated_at: now.toISOString(),
        window: { label: resolved.window.label, visitor_unit: resolved.window.visitor_unit, partial: resolved.window.partial },
        ...breakdown,
      },
    });
  } catch (e) {
    console.error('[admin/visits-breakdown] не удалось построить разбивку:', e instanceof Error ? e.message : e);
    return NextResponse.json({ success: false, error: safeMsg(e, 'Не удалось прочитать визиты') }, { status: 500 });
  }
}
