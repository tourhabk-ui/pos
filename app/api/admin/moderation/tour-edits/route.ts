/**
 * GET /api/admin/moderation/tour-edits — туры и правки туров, которые ждут
 * проверки (миграция 1507; план готовности 23.11, этап 4).
 *
 * В списке нет телефона и почты: администратору нужны владелец, тур и сама
 * правка. Пустой список — проверять нечего, отказ базы — 503, не пустота.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { listPendingTourEdits } from '@/lib/tours/moderation-store';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authOrResponse = await requireAdmin(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const listed = await listPendingTourEdits();
  if (listed.outcome === 'db_error') {
    return NextResponse.json({ success: false, error: 'Не смог прочитать правки туров' }, { status: 503 });
  }
  return NextResponse.json({ success: true, data: { edits: listed.edits } });
}
