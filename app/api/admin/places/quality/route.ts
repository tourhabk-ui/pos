/**
 * GET /api/admin/places/quality?source=idilesom
 *
 * Health-метрика (issue #226): доля places с заполненными lat/lng,
 * description (≥300 симв.) и category. ?source= фильтрует по
 * places.source_name (ILIKE) — например, для оценки конкретно последнего
 * импорта idilesom.com.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { computePlacesQuality } from '@/lib/services/routes/places-quality';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const source = request.nextUrl.searchParams.get('source')?.trim() || undefined;
  const quality = await computePlacesQuality(source);
  return NextResponse.json(quality);
}
