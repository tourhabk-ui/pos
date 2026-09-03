/**
 * Оплата места в поездке перевозчика по QR СБП.
 *   POST /api/carrier-trips/bookings/[id]/qr — выпустить QR на подтверждённый заказ
 *   GET  /api/carrier-trips/bookings/[id]/qr — состояние оплаты (опрос с экрана)
 *
 * Только для заказчика (вход обязателен). Сумма — из заказа, не из тела.
 * Приёмник оплаты — общий с турами: /api/payments/tochka/webhook, ветка
 * settleSeatPaymentByQr. Решение владельца 02.09: «делай по QR».
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth/middleware';
import { query } from '@/lib/database';
import { createRateLimiter } from '@/lib/rate-limit';
import { issueSeatQr, ISSUE_FAILURE_STATUS } from '@/lib/transfers/seat-payment';
import { getSeatBookingForPayment } from '@/lib/transfers/service';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });

async function partnerIdsOf(userId: string): Promise<string[]> {
  const r = await query<{ id: string }>(`SELECT id FROM partners WHERE user_id = $1`, [userId]);
  return r.rows.map(x => x.id);
}

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  if (!limiter.check(auth.userId)) {
    return NextResponse.json({ success: false, error: 'Слишком много запросов, попробуйте позже' }, { status: 429 });
  }
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ success: false, error: 'Некорректный id заказа' }, { status: 400 });
  }

  let partnerIds: string[];
  try {
    partnerIds = await partnerIdsOf(auth.userId);
  } catch (err) {
    console.error('[carrier-trips/qr] partner lookup:', err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: 'Не удалось определить заказчика — попробуйте позже' }, { status: 503 });
  }

  const result = await issueSeatQr({ bookingId: id, userId: auth.userId, partnerIds });
  if (!result.ok) {
    return NextResponse.json(
      { success: false, code: result.code, error: result.message },
      { status: ISSUE_FAILURE_STATUS[result.code] },
    );
  }
  return NextResponse.json({
    success: true,
    amount: result.amount,
    qrCode: result.qrCode,
    qrLink: result.qrLink,
    payload: result.payload,
    expiresAt: result.expiresAt,
  });
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ success: false, error: 'Некорректный id заказа' }, { status: 400 });
  }
  try {
    const [booking, partnerIds] = await Promise.all([getSeatBookingForPayment(id), partnerIdsOf(auth.userId)]);
    if (!booking) return NextResponse.json({ success: false, error: 'Заказ мест не найден' }, { status: 404 });
    const mine =
      booking.ordered_by_user_id === auth.userId ||
      (booking.ordered_by_partner_id !== null && partnerIds.includes(booking.ordered_by_partner_id));
    if (!mine) return NextResponse.json({ success: false, error: 'Это не ваш заказ' }, { status: 403 });
    return NextResponse.json({
      success: true,
      paid: booking.payment_status === 'paid',
      payment_status: booking.payment_status,
      status: booking.status,
      qr_expires_at: booking.qr_expires_at,
      paid_at: booking.paid_at,
    });
  } catch (err) {
    console.error('[carrier-trips/qr] status:', err instanceof Error ? err.message : err);
    // Отказ — не «не оплачено»: экран обязан сказать «не смогли проверить».
    return NextResponse.json({ success: false, error: 'Не удалось проверить оплату — попробуйте позже' }, { status: 503 });
  }
}
