/**
 * GET /api/admin/partners/queues — очереди партнёрского контура одним ответом
 * (план готовности 23.11, этап 6): кто ждёт одобрения, кто без канала, сколько
 * туров и правок на проверке, сколько тестовых профилей.
 *
 * В ответе только числа — ни названий, ни контактов. Число, которое прочитать
 * не удалось, приходит как 'unknown', а не нулём: остальные числа при этом
 * остаются.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { readPartnerQueues } from '@/lib/admin/partner-queues';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authOrResponse = await requireAdmin(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;
  return NextResponse.json({ success: true, data: await readPartnerQueues() });
}
