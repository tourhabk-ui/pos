/**
 * GET /api/admin/moderation/charter-price-edits — черновики прайса перевозчиков (1355).
 *
 * В списке нет телефона и почты: администратору нужны перевозчик, строка и
 * сама правка. Пустой список — правок нет, отказ базы — 503, не пустота.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { listPendingPriceEdits } from '@/lib/transfers/price-edit-store';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authOrResponse = await requireAdmin(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const listed = await listPendingPriceEdits();
  if (listed.outcome === 'db_error') {
    return NextResponse.json({ success: false, error: 'Не смог прочитать правки прайса перевозчиков' }, { status: 503 });
  }
  return NextResponse.json({ success: true, data: { edits: listed.edits } });
}
