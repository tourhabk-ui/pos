/**
 * GET /api/places/[id]
 * Полные данные карточки места. Логика — lib/places/place-detail.ts (её же
 * зовёт серверная страница /places/[id]).
 *
 * `?view=0` — читать без счёта просмотра: карточка места у дня плана
 * (/planner, 22.11) — не визит на страницу места.
 */

import { NextRequest, NextResponse } from 'next/server';
import { loadPlaceDetail } from '@/lib/places/place-detail';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const countView = req.nextUrl.searchParams.get('view') !== '0';
  const r = await loadPlaceDetail(id, { countView });
  return NextResponse.json(r.body, { status: r.status });
}
