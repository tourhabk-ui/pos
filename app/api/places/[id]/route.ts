/**
 * GET /api/places/[id]
 * Полные данные карточки места. Логика — lib/places/place-detail.ts (её же
 * зовёт серверная страница /places/[id]).
 */

import { NextRequest, NextResponse } from 'next/server';
import { loadPlaceDetail } from '@/lib/places/place-detail';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const r = await loadPlaceDetail(id, { countView: true });
  return NextResponse.json(r.body, { status: r.status });
}
