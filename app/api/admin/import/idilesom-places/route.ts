/**
 * POST /api/admin/import/idilesom-places
 *
 * Импортирует места из idilesom.com/kam/places?district=0 в таблицу places.
 * Дедуплицирует по схожести названий.
 * Если у места есть GPS-трек — дополнительно создаёт запись в kamchatka_routes.
 *
 * Body (опционально):
 *   { limit?: number, dry_run?: boolean }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { importIdilesomPlaces } from '@/lib/services/idilesom-importer';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;

  let limit: number | undefined;
  let dry_run = false;

  try {
    const body = await req.json().catch(() => ({})) as { limit?: number; dry_run?: boolean };
    if (typeof body.limit === 'number' && body.limit > 0) limit = body.limit;
    if (body.dry_run === true) dry_run = true;
  } catch { /* no body is fine */ }

  try {
    const result = await importIdilesomPlaces({ limit, dry_run });
    return NextResponse.json({ ok: true, dry_run, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
