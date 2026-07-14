/**
 * GET /api/hub/operator/bookings/[id]/document
 *
 * PDF-ваучер брони с листом безопасности (опасности маршрута + МЧС + снаряжение).
 * Только для оператора-владельца брони. Данные — из operator_bookings + operator_tours
 * + partners + kamchatka_routes (safety-поля через operator_tours.route_id).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/middleware';
import { query } from '@/lib/database';
import { generateBookingVoucherPDF, type BookingDocData } from '@/lib/pdf/booking-document';

export const dynamic = 'force-dynamic';

async function getOperatorId(userId: string): Promise<string | null> {
  const r = await query(`SELECT id FROM partners WHERE user_id = $1 LIMIT 1`, [userId]);
  return (r.rows[0]?.id as string) || null;
}

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireOperator(request);
  if (auth instanceof NextResponse) return auth;

  const operatorId = await getOperatorId(auth.userId);
  if (!operatorId) return NextResponse.json({ error: 'Не оператор' }, { status: 403 });

  let bookingId: bigint;
  try {
    bookingId = BigInt(params.id);
  } catch {
    return NextResponse.json({ error: 'Неверный ID брони' }, { status: 400 });
  }

  const result = await query<{
    id: string; tourist_name: string; tourist_email: string | null; tourist_phone: string | null;
    participants: number | string; booking_date: string; final_price: string | null;
    special_requests: string | null; booking_status: string | null;
    tour_title: string; location_name: string | null;
    operator_name: string; operator_contacts: Record<string, unknown> | null;
    route_title: string | null; hazards: string[] | null; equipment: string[] | null;
    mchs_phone: string | null; mchs_registration_required: boolean | null; park_name: string | null;
  }>(
    `SELECT b.id, b.tourist_name, b.tourist_email, b.tourist_phone, b.participants,
            b.booking_date, b.final_price, b.special_requests, b.booking_status,
            t.title AS tour_title, t.location_name,
            p.name AS operator_name, p.contacts AS operator_contacts,
            kr.title AS route_title, kr.hazards, kr.equipment, kr.mchs_phone,
            kr.mchs_registration_required, kr.park_name
     FROM operator_bookings b
     JOIN operator_tours t ON b.operator_tour_id = t.id
     JOIN partners p ON p.id = t.operator_id
     LEFT JOIN kamchatka_routes kr ON kr.id = t.route_id
     WHERE b.id = $1 AND t.operator_id = $2 AND b.deleted_at IS NULL
     LIMIT 1`,
    [bookingId, operatorId],
  );

  const b = result.rows[0];
  if (!b) return NextResponse.json({ error: 'Бронь не найдена' }, { status: 404 });

  const contacts = (b.operator_contacts ?? {}) as { phone?: string };

  const data: BookingDocData = {
    bookingId: String(b.id),
    operatorName: b.operator_name,
    operatorPhone: contacts.phone ?? null,
    tourTitle: b.tour_title,
    locationName: b.location_name,
    routeTitle: b.route_title,
    bookingDate: typeof b.booking_date === 'string' ? b.booking_date.slice(0, 10) : new Date(b.booking_date).toISOString().slice(0, 10),
    participants: Number(b.participants) || 1,
    totalPrice: b.final_price != null ? parseFloat(b.final_price) : 0,
    touristName: b.tourist_name,
    touristPhone: b.tourist_phone,
    touristEmail: b.tourist_email,
    specialRequests: b.special_requests,
    status: b.booking_status,
    hazards: b.hazards,
    equipment: b.equipment,
    mchsPhone: b.mchs_phone,
    mchsRegistrationRequired: b.mchs_registration_required,
    parkName: b.park_name,
  };

  try {
    const pdf = await generateBookingVoucherPDF(data);
    return new NextResponse(pdf as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="voucher-${b.id}.pdf"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка генерации PDF';
    return NextResponse.json({ error: `Не удалось сформировать документ: ${msg}` }, { status: 500 });
  }
}
