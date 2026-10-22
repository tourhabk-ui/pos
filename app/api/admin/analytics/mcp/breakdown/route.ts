/**
 * GET /api/admin/analytics/mcp/breakdown — расшифровка числа со страницы
 * «Запросы через MCP» по камчатским суткам: какая программа звала, сколько
 * раз, какими инструментами и о чём (главный аргумент из журнала). Правила —
 * lib/mcp/day-breakdown.
 *
 * ?origin=external|self|probe|own · ?outcome=all|failure|refusal ·
 * ?days=1..30 (сколько суток) · ?skip=0..29 (сколько последних пропустить:
 * 0 — с сегодняшних, 1 — со вчерашних).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { BREAKDOWN_ORIGINS, BREAKDOWN_OUTCOMES, readMcpBreakdown } from '@/lib/mcp/day-breakdown';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  origin: z.enum(BREAKDOWN_ORIGINS, { message: 'Род вызова: external, self, probe или own' }).default('external'),
  outcome: z.enum(BREAKDOWN_OUTCOMES, { message: 'Исход: all, failure или refusal' }).default('all'),
  days: z.coerce.number().int().min(1, 'Суток — от 1 до 30').max(30, 'Суток — от 1 до 30').default(1),
  skip: z.coerce.number().int().min(0, 'Пропуск — от 0 до 29 суток').max(29, 'Пропуск — от 0 до 29 суток').default(0),
});

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const sp = request.nextUrl.searchParams;
  const parsed = QuerySchema.safeParse({
    origin: sp.get('origin') ?? undefined,
    outcome: sp.get('outcome') ?? undefined,
    days: sp.get('days') ?? undefined,
    skip: sp.get('skip') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Неверные параметры' }, { status: 400 });
  }
  try {
    const data = await readMcpBreakdown(parsed.data, new Date());
    return NextResponse.json({ success: true, data });
  } catch (err) {
    // Отказ не глушится (§4.0): SQLSTATE и текст в лог, без данных строк.
    const e = err as { code?: unknown; message?: unknown } | null;
    console.error('[admin/analytics/mcp/breakdown] расшифровка не построена:',
      typeof e?.code === 'string' ? e.code : 'нет SQLSTATE', typeof e?.message === 'string' ? e.message.slice(0, 300) : '');
    return NextResponse.json({ success: false, error: 'Не удалось построить расшифровку MCP' }, { status: 500 });
  }
}
