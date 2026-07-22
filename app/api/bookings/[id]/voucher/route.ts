/**
 * GET /api/bookings/[id]/voucher — PDF-ваучер брони туриста («Ваучер»).
 * JWT обязателен; отдаётся только своя бронь (b.user_id = auth.userId).
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { requireAuth } from '@/lib/auth/middleware';
import { generateBookingVoucherPDF } from '@/lib/pdf/booking-voucher';
import { normalizeBookingId } from '@/lib/bookings/booking-id';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  // operator_bookings.id — BIGINT; список отдаёт его как `op-<id>`. UUID-проверки
  // тут быть не может (иначе ваучер всегда 400): нормализуем к bigint-строке.
  const id = normalizeBookingId((await params).id);
  if (!id) {
    return NextResponse.json({ success: false, error: 'Некорректный id' }, { status: 400 });
  }

  const { rows } = await query<{
    id: string; date: string; participants: number | null;
    total_price: number | null; status: string | null; payment_status: string | null;
    tour_name: string; operator_name: string | null;
  }>(
    `SELECT b.id, b.booking_date AS date, b.participants,
            COALESCE(b.final_price, b.base_total_price) AS total_price,
            b.booking_status AS status, b.payment_status,
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
  const pdf = await generateBookingVoucherPDF({
    id: b.id,
    tourName: b.tour_name,
    operatorName: b.operator_name,
    date: b.date,
    participants: b.participants,
    totalPrice: b.total_price != null ? Number(b.total_price) : null,
    status: b.status,
    paymentStatus: b.payment_status,
  });

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="vedar-voucher-${b.id}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}
