/**
 * GET /api/admin/places/audit
 *
 * Диагностика качества данных в places для владельца (админ-сессия). Только
 * читает. Логика — в lib/places/audit.ts (общая с /api/cron/places-audit).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { computePlacesAudit } from '@/lib/places/audit';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const audit = await computePlacesAudit();
  return NextResponse.json(audit);
}
