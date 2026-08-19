/**
 * GET /api/trips/share/[token]/gpx
 * GPX дней плана из share-ссылки («Мой план 2.0», C-6 — офлайн-план).
 * Публично, как и сама страница /trip/[token]: тот же токен, те же условия
 * (is_public = TRUE, deleted_at IS NULL) — ничего сверх видимого на странице
 * в файл не попадает.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
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
    const { rows } = await pool.query<{ title: string; arrival_date: string | null; days: unknown }>(
      `SELECT title, arrival_date, days
       FROM user_trips
       WHERE share_token = $1 AND is_public = TRUE AND deleted_at IS NULL`,
      [token]
    );

    if (rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Маршрут не найден или не опубликован' }, { status: 404 });
    }

    const raw = Array.isArray(rows[0]!.days) ? rows[0]!.days as Array<{ day?: number; title?: string; coords?: [number, number] }> : [];
    const arrivalMs = rows[0]!.arrival_date ? new Date(rows[0]!.arrival_date).getTime() : NaN;
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

    return new NextResponse(buildPlanGpx(rows[0]!.title, days), {
      headers: {
        'Content-Type': 'application/gpx+xml',
        // Заголовок собирает plan-gpx: ASCII-имя обязательно — кириллица в
        // ByteString роняла ответ, и каждое скачивание GPX было 500.
        'Content-Disposition': planGpxContentDisposition(rows[0]!.title),
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка сервера' }, { status: 500 });
  }
}
