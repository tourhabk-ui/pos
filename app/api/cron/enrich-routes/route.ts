/**
 * GET /api/cron/enrich-routes
 *
 * Cron-триггер писателя описаний (enrichDescriptions, партия 20).
 * С 15.10 он пишет только МЕСТАМ: описание маршрута по одному названию —
 * догадка, и 1261 сняла 155 таких с карточек (см. PLACES_ONLY в
 * app/api/admin/enrich-routes). Имя адреса оставлено ради расписания.
 *
 * Auth: CRON_SECRET header
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { enrichDescriptions } from '@/app/api/admin/enrich-routes/route';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  if (!timingSafeCompare(secret, cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Прямой вызов логики обогащения — без HTTP self-call (он падал с "fetch failed":
    // сервер не всегда может дёрнуть собственный публичный домен / hairpin NAT).
    return await enrichDescriptions(20, false, false);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    );
  }
}
