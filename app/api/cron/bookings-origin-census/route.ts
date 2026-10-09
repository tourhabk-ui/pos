/**
 * GET /api/cron/bookings-origin-census?hours=48 — откуда взялись брони тура
 * за окно: created_via, статус, тур, оператор, есть ли контакт — без ПД.
 * ?scope=unlinked — не окно, а брони без клиента CRM (предикат задела).
 * Только чтение. Повод и правила — в lib/analytics/bookings-origin.ts.
 *
 * Запускается рукой (manual): по адресу с CRON_SECRET, с раннера prod-check.
 */
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { censusBookingsOrigin, clampHours, parseScope } from '@/lib/analytics/bookings-origin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const hours = clampHours(req.nextUrl.searchParams.get('hours'));
  const scope = parseScope(req.nextUrl.searchParams.get('scope'));
  const report = await censusBookingsOrigin(hours, undefined, scope);
  return NextResponse.json({ ok: report.failed.length === 0, probe: 'bookings_origin_census_v1', ...report });
}
