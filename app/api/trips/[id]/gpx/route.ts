/**
 * GET /api/trips/[id]/gpx — GPX точек дней своей поездки для кабинета туриста.
 * Только владельцу и без публикации: тот же файл, что /api/trips/share/[token]/gpx,
 * но поездка не становится публичной ради скачивания.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { requireAuth } from '@/lib/auth/middleware';
import { buildPlanGpx, planGpxContentDisposition, planGpxPoints, type PlanGpxDay } from '@/lib/trips/plan-gpx';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authOrResponse = await requireAuth(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;
  const { userId } = authOrResponse;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
  }

  try {
    const { rows } = await pool.query<{ title: string; arrival_date: string | null; days: unknown }>(
      `SELECT title, arrival_date, days FROM user_trips
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, userId],
    );
    const trip = rows[0];
    if (!trip) return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });

    const raw = (Array.isArray(trip.days) ? trip.days : []) as Array<{ day?: number; title?: string; coords?: [number, number] }>;
    const arrivalMs = trip.arrival_date ? new Date(trip.arrival_date).getTime() : NaN;
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
    return new NextResponse(buildPlanGpx(trip.title, days), {
      headers: {
        'Content-Type': 'application/gpx+xml',
        'Content-Disposition': planGpxContentDisposition(trip.title),
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown };
    console.error('[trips/gpx] GPX не собран:', typeof e?.code === 'string' ? e.code : 'нет SQLSTATE', typeof e?.message === 'string' ? e.message.slice(0, 300) : '');
    return NextResponse.json({ success: false, error: 'Ошибка сервера' }, { status: 500 });
  }
}
