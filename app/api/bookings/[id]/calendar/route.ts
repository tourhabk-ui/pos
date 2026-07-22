/**
 * GET /api/bookings/[id]/calendar — .ics брони туриста («В календарь»).
 * JWT обязателен; отдаётся только своя бронь (b.user_id = auth.userId).
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { requireAuth } from '@/lib/auth/middleware';
import { buildBookingIcs } from '@/lib/calendar/ics';
import { normalizeBookingId } from '@/lib/bookings/booking-id';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  // operator_bookings.id — BIGINT; список отдаёт его как `op-<id>`. UUID-проверки
  // тут быть не может (иначе .ics всегда 400): нормализуем к bigint-строке.
  const id = normalizeBookingId((await params).id);
  if (!id) {
    return NextResponse.json({ success: false, error: 'Некорректный id' }, { status: 400 });
  }

  const { rows } = await query<{
    id: string; date: string; participants: number | null;
    tour_name: string; operator_name: string | null;
  }>(
    `SELECT b.id, b.booking_date AS date, b.participants,
            t.title AS tour_name, p.name AS operator_name
       FROM operator_bookings b
       JOIN operator_tours t ON b.operator_tour_id = t.id
       LEFT JOIN partners p ON t.operator_id = p.id
      WHERE b.id = $1 AND b.user_id = $2 AND b.deleted_at IS NULL
      LIMIT 1`,
    [id, auth.userId],
  );

  if (rows.length === 0) {
    return NextResponse.json({ success: false, error: 'Бронирование не найдено' }, { status: 404 });
  }

  const b = rows[0];
  const ics = buildBookingIcs({
    id: b.id,
    tourName: b.tour_name,
    date: b.date,
    operatorName: b.operator_name,
    participants: b.participants,
  });

  return new NextResponse(ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="vedar-booking-${b.id}.ics"`,
      'Cache-Control': 'no-store',
    },
  });
}
