/**
 * GET /api/admin/moderation/rental-edits — черновики цены и описания проката.
 *
 * В списке нет телефона и почты: администратору нужны прокатчик, машина
 * и сама правка. Пустой список — правок нет, а не «не смог прочитать».
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { listPendingOfferEdits } from '@/lib/rental/offer-edit-store';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authOrResponse = await requireAdmin(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const listed = await listPendingOfferEdits();
  if (listed.outcome === 'db_error') {
    return NextResponse.json(
      { success: false, error: 'Не смог прочитать правки прайса' },
      { status: 503 },
    );
  }
  return NextResponse.json({ success: true, data: { edits: listed.edits } });
}
