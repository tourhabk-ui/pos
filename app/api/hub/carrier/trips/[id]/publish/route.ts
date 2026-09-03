/**
 * POST /api/hub/carrier/trips/[id]/publish — выставить остаток мест в витрину
 * или снять. Body: { published: boolean }.
 *
 * Витрина читает ТОЛЬКО опубликованные поездки (listPublishedTrips), и этот
 * переключатель — единственная дверь на неё. Сторож carrier-api держит, что
 * витрина не читает transfer_trips напрямую.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireCarrier, FAILURE_STATUS } from '@/lib/transfers/carrier-auth';
import { setTripPublished } from '@/lib/transfers/service';

export const dynamic = 'force-dynamic';

const Schema = z.object({ published: z.boolean() });

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const carrier = await requireCarrier(request);
  if (carrier instanceof NextResponse) return carrier;

  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) {
    return NextResponse.json({ success: false, error: 'Некорректный id поездки' }, { status: 400 });
  }
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Нужно поле published: true/false' }, { status: 400 });
  }
  const result = await setTripPublished({ tripId: id, partnerId: carrier.partnerId, published: parsed.data.published });
  if (!result.ok) {
    return NextResponse.json(
      { success: false, code: result.code, error: result.message },
      { status: FAILURE_STATUS[result.code] ?? 500 },
    );
  }
  return NextResponse.json({ success: true, data: result.value });
}
