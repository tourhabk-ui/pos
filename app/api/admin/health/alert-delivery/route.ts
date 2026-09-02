/**
 * GET /api/admin/health/alert-delivery
 *
 * Доставка тревог одним взглядом (#1485): подписки, свежесть сейсмо-приёма,
 * разосланное за сутки, недоставленное. Только чтение. Каждое число несёт
 * свой исход «не смогли посчитать» — см. lib/services/safety/alert-delivery-health.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { computeAlertDeliveryHealth } from '@/lib/services/safety/alert-delivery-health';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const data = await computeAlertDeliveryHealth();
    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('[health/alert-delivery]', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, error: 'Не удалось собрать здоровье доставки тревог' },
      { status: 500 },
    );
  }
}
