/**
 * GET /api/hub/carrier/requests?status=requested — запросы мест на поездки
 * перевозчика. По умолчанию — нерешённые: именно их Watchdog считает
 * «без ответа > 24ч» (checkPendingTransferBookings).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireCarrier } from '@/lib/transfers/carrier-auth';
import { listSeatRequests } from '@/lib/transfers/service';

export const dynamic = 'force-dynamic';

const StatusSchema = z.enum(['requested', 'confirmed', 'declined', 'cancelled']).default('requested');

export async function GET(request: NextRequest) {
  const carrier = await requireCarrier(request);
  if (carrier instanceof NextResponse) return carrier;

  const status = StatusSchema.safeParse(request.nextUrl.searchParams.get('status') ?? undefined);
  if (!status.success) {
    return NextResponse.json({ success: false, error: 'Неизвестный статус запроса' }, { status: 400 });
  }
  try {
    const rows = await listSeatRequests(carrier.partnerId, status.data);
    return NextResponse.json({ success: true, data: rows });
  } catch (err) {
    console.error('[carrier/requests] list:', err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: 'Не удалось прочитать запросы' }, { status: 503 });
  }
}
