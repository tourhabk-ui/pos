/**
 * POST /api/admin/import/visitkamchatka-gpx
 *
 * Скачивает 10 официальных GPX-треков с visitkamchatka.ru,
 * матчит на kamchatka_routes по стартовой точке (≤10 км),
 * записывает geometry (GeoJSON LineString + elevation).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { importVisitKamchatkaGpx } from '@/lib/services/visitkamchatka-gpx-importer';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const result = await importVisitKamchatkaGpx();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
