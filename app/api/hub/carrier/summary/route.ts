/**
 * GET /api/hub/carrier/summary — сводка перевозчика за 30 дней (#2862 этап D):
 * заявки, ответы, медиана первого ответа, поездки, отзывы и средняя.
 *
 * Каждый блок может не прочитаться отдельно — тогда он null, не ноль (§4.0).
 * Имён и телефонов в ответе нет: числа и слова.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireCarrier } from '@/lib/transfers/carrier-auth';
import { loadCarrierSummary } from '@/lib/transfers/carrier-summary-store';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const carrier = await requireCarrier(request);
  if (carrier instanceof NextResponse) return carrier;
  const summary = await loadCarrierSummary(carrier.partnerId);
  return NextResponse.json({ success: true, data: summary });
}
