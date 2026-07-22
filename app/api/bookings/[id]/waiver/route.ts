/**
 * Вейвер брони — согласие с рисками + медицинская декларация для
 * высокорисковых туров (вулкан, вертолёт, рафтинг, зимний выход).
 *
 * GET  /api/bookings/[id]/waiver — статус: нужен ли вейвер, подписан ли, данные.
 * POST /api/bookings/[id]/waiver — подписать (только владелец брони, только
 *                                  если тур высокорисковый). Переподпись = upsert.
 *
 * JWT обязателен; отдаётся/пишется только своя бронь (b.user_id = auth.userId).
 * operator_bookings.id — BIGINT, приходит из URL как `op-<id>` или `<id>`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { requireAuth } from '@/lib/auth/middleware';
import { normalizeBookingId } from '@/lib/bookings/booking-id';
import { isHighRiskTour, highRiskReason } from '@/lib/safety/tour-risk';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

interface BookingRow {
  id: string;
  tour_title: string;
  difficulty: string | null;
  activity_type: string | null;
  signer_name: string | null;
}

interface WaiverRow {
  signer_name: string;
  risks_acknowledged: boolean;
  fit_to_participate: boolean;
  medical_conditions: string | null;
  allergies: string | null;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  signed_at: string;
}

async function loadBooking(bookingId: string, userId: string): Promise<BookingRow | null> {
  const { rows } = await query<BookingRow>(
    `SELECT b.id::text,
            t.title       AS tour_title,
            t.difficulty,
            t.activity_type,
            b.tourist_name AS signer_name
       FROM operator_bookings b
       JOIN operator_tours t ON b.operator_tour_id = t.id
      WHERE b.id = $1 AND b.user_id = $2 AND b.deleted_at IS NULL
      LIMIT 1`,
    [bookingId, userId],
  );
  return rows[0] ?? null;
}

async function loadWaiver(bookingId: string): Promise<WaiverRow | null> {
  const { rows } = await query<WaiverRow>(
    `SELECT signer_name, risks_acknowledged, fit_to_participate,
            medical_conditions, allergies,
            emergency_contact_name, emergency_contact_phone, signed_at
       FROM booking_waivers
      WHERE booking_id = $1
      LIMIT 1`,
    [bookingId],
  );
  return rows[0] ?? null;
}

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

  const booking = await loadBooking(bookingId, auth.userId);
  if (!booking) {
    return NextResponse.json({ success: false, error: 'Бронирование не найдено' }, { status: 404 });
  }

  const required = isHighRiskTour(booking.difficulty, booking.activity_type);
  const waiver = required ? await loadWaiver(bookingId) : null;

  return NextResponse.json({
    success: true,
    data: {
      required,
      signed: waiver != null,
      reason: highRiskReason(booking.difficulty, booking.activity_type),
      tourTitle: booking.tour_title,
      defaultSignerName: booking.signer_name ?? '',
      waiver,
    },
  });
}

const signSchema = z.object({
  signerName: z.string().trim().min(2, 'Укажите ФИО').max(255),
  risksAcknowledged: z.literal(true, { errorMap: () => ({ message: 'Подтвердите осознание рисков' }) }),
  fitToParticipate: z.literal(true, { errorMap: () => ({ message: 'Подтвердите пригодность к участию' }) }),
  medicalConditions: z.string().trim().max(2000).optional().nullable(),
  allergies: z.string().trim().max(1000).optional().nullable(),
  emergencyContactName: z.string().trim().min(2, 'Укажите контактное лицо').max(255),
  emergencyContactPhone: z.string().trim().min(5, 'Укажите телефон контакта').max(50),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const bookingId = normalizeBookingId((await params).id);
  if (!bookingId) {
    return NextResponse.json({ success: false, error: 'Некорректный id' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Некорректное тело запроса' }, { status: 400 });
  }

  const parsed = signSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.errors[0]?.message ?? 'Проверьте поля формы' },
      { status: 400 },
    );
  }

  const booking = await loadBooking(bookingId, auth.userId);
  if (!booking) {
    return NextResponse.json({ success: false, error: 'Бронирование не найдено' }, { status: 404 });
  }

  if (!isHighRiskTour(booking.difficulty, booking.activity_type)) {
    return NextResponse.json(
      { success: false, error: 'Для этого тура вейвер не требуется' },
      { status: 400 },
    );
  }

  const d = parsed.data;
  await query(
    `INSERT INTO booking_waivers (
       booking_id, user_id, signer_name, risks_acknowledged, fit_to_participate,
       medical_conditions, allergies, emergency_contact_name, emergency_contact_phone, signed_at
     ) VALUES ($1, $2, $3, true, true, $4, $5, $6, $7, now())
     ON CONFLICT (booking_id) DO UPDATE SET
       signer_name             = EXCLUDED.signer_name,
       risks_acknowledged      = true,
       fit_to_participate      = true,
       medical_conditions      = EXCLUDED.medical_conditions,
       allergies               = EXCLUDED.allergies,
       emergency_contact_name  = EXCLUDED.emergency_contact_name,
       emergency_contact_phone = EXCLUDED.emergency_contact_phone,
       signed_at               = now()`,
    [
      bookingId, auth.userId, d.signerName,
      d.medicalConditions || null, d.allergies || null,
      d.emergencyContactName, d.emergencyContactPhone,
    ],
  );

  return NextResponse.json({ success: true, data: { signed: true } });
}
