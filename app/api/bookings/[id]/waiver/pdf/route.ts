/**
 * GET /api/bookings/[id]/waiver/pdf — PDF подписанного вейвера.
 * JWT обязателен; только своя бронь и только если вейвер уже подписан.
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { requireAuth } from '@/lib/auth/middleware';
import { normalizeBookingId } from '@/lib/bookings/booking-id';
import { highRiskReason } from '@/lib/safety/tour-risk';
import { generateWaiverPDF } from '@/lib/pdf/waiver-generator';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const bookingId = normalizeBookingId((await params).id);
  if (!bookingId) {
    return NextResponse.json({ success: false, error: 'Некорректный id' }, { status: 400 });
  }

  const { rows } = await query<{
    tour_title: string; difficulty: string | null; activity_type: string | null;
    signer_name: string; medical_conditions: string | null; allergies: string | null;
    emergency_contact_name: string; emergency_contact_phone: string; signed_at: string;
  }>(
    `SELECT t.title AS tour_title, t.difficulty, t.activity_type,
            w.signer_name, w.medical_conditions, w.allergies,
            w.emergency_contact_name, w.emergency_contact_phone, w.signed_at
       FROM booking_waivers w
       JOIN operator_bookings b ON b.id = w.booking_id
       JOIN operator_tours t ON t.id = b.operator_tour_id
      WHERE w.booking_id = $1 AND b.user_id = $2 AND b.deleted_at IS NULL
      LIMIT 1`,
    [bookingId, auth.userId],
  );

  if (rows.length === 0) {
    return NextResponse.json({ success: false, error: 'Вейвер не найден' }, { status: 404 });
  }

  const r = rows[0];
  const pdf = await generateWaiverPDF({
    bookingId,
    tourName: r.tour_title,
    reason: highRiskReason(r.difficulty, r.activity_type),
    signerName: r.signer_name,
    medicalConditions: r.medical_conditions,
    allergies: r.allergies,
    emergencyContactName: r.emergency_contact_name,
    emergencyContactPhone: r.emergency_contact_phone,
    signedAt: r.signed_at,
  });

  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="vedar-waiver-${bookingId}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}
