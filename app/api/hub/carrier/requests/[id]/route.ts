/**
 * POST /api/hub/carrier/requests/[id] — решение перевозчика по запросу мест.
 * Body: { action: 'confirm', price?: number } | { action: 'decline', reason: string }.
 *
 * Гейт брони: места занимаются ТОЛЬКО здесь и только через confirmSeats —
 * под замком строки поездки (FOR UPDATE), в одной транзакции. Своего UPDATE
 * по transfer_seat_bookings у роута нет и быть не должно; сторож carrier-api
 * это держит.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireCarrier, FAILURE_STATUS } from '@/lib/transfers/carrier-auth';
import { confirmSeats, declineSeats } from '@/lib/transfers/service';

export const dynamic = 'force-dynamic';

const DecisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm'), price: z.number().positive().optional().nullable() }),
  z.object({ action: z.literal('decline'), reason: z.string().trim().min(2, 'Назовите причину отказа').max(300) }),
]);

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const carrier = await requireCarrier(request);
  if (carrier instanceof NextResponse) return carrier;

  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ success: false, error: 'Некорректный id запроса' }, { status: 400 });
  }
  const parsed = DecisionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Нужно action: confirm | decline' },
      { status: 400 },
    );
  }

  const result = parsed.data.action === 'confirm'
    ? await confirmSeats({ bookingId: id, partnerId: carrier.partnerId, price: parsed.data.price ?? null })
    : await declineSeats({ bookingId: id, partnerId: carrier.partnerId, reason: parsed.data.reason });

  if (!result.ok) {
    return NextResponse.json(
      { success: false, code: result.code, error: result.message },
      { status: FAILURE_STATUS[result.code] ?? 500 },
    );
  }
  return NextResponse.json({ success: true, data: result.value });
}
