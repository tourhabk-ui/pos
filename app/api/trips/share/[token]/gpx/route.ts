/**
 * GET /api/trips/share/[token]/gpx
 * GPX дней плана из share-ссылки («Мой план 2.0», C-6 — офлайн-план).
 * Публично, как и сама страница /trip/[token]: тот же токен и то же правило
 * видимости (lib/trips/shared-plan — опубликованная поездка или черновик
 * плана Кузьмича/MCP, #2225) — ничего сверх видимого на странице в файл не
 * попадает.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readSharedPlan } from '@/lib/trips/shared-plan';
import { attachMcpAttribution, MCP_ATTRIBUTION } from '@/lib/mcp/handoff';
import { buildPlanGpx, planGpxContentDisposition, planGpxPoints, type PlanGpxDay } from '@/lib/trips/plan-gpx';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  if (!/^[0-9a-f-]{36}$/i.test(token)) {
    return NextResponse.json({ success: false, error: 'Неверный токен' }, { status: 400 });
  }

  try {
    const read = await readSharedPlan(token);
    if (read.kind === 'failed') {
      return NextResponse.json({ success: false, error: 'План сейчас не прочитался — попробуйте чуть позже' }, { status: 503 });
    }
    if (read.kind === 'missing') {
      return NextResponse.json({ success: false, error: 'Маршрут не найден или не опубликован' }, { status: 404 });
    }
    const plan = read.plan;

    const raw = plan.days as Array<{ day?: number; title?: string; coords?: [number, number] }>;
    const arrivalMs = plan.arrival_date ? new Date(plan.arrival_date).getTime() : NaN;
    const days: PlanGpxDay[] = raw
      .filter((d) => typeof d.day === 'number' && typeof d.title === 'string')
      .map((d) => ({
        day: d.day as number,
        title: d.title as string,
        coords: d.coords,
        date: Number.isFinite(arrivalMs)
          ? new Date(arrivalMs + ((d.day as number) - 1) * 86400000).toISOString().slice(0, 10)
          : undefined,
      }));

    if (planGpxPoints(days).length === 0) {
      return NextResponse.json({ success: false, error: 'В плане нет точек с координатами' }, { status: 404 });
    }

    // Атрибуция MCP-handoff (v2, #60): офлайн-пакет скачан после прихода по
    // ссылке агента. Только UUID handoff-а из проверенной cookie.
    await attachMcpAttribution(
      request.cookies.get(MCP_ATTRIBUTION.cookieName)?.value,
      'offline_bundle_downloaded',
    );

    return new NextResponse(buildPlanGpx(plan.title, days), {
      headers: {
        'Content-Type': 'application/gpx+xml',
        // Заголовок собирает plan-gpx: ASCII-имя обязательно — кириллица в
        // ByteString роняла ответ, и каждое скачивание GPX было 500.
        'Content-Disposition': planGpxContentDisposition(plan.title),
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown };
    console.error('[trips/share/gpx] GPX не собран:', typeof e?.code === 'string' ? e.code : 'нет SQLSTATE', typeof e?.message === 'string' ? e.message.slice(0, 300) : '');
    return NextResponse.json({ success: false, error: 'Ошибка сервера' }, { status: 500 });
  }
}
