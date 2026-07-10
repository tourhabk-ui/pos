/**
 * GET /api/admin/routes/audit
 *
 * Диагностика качества данных в kamchatka_routes для владельца (админ-сессия).
 * Только читает. Логика — в lib/routes/audit.ts (общая с /api/cron/routes-audit).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { computeRoutesAudit } from '@/lib/routes/audit';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const audit = await computeRoutesAudit();
  return NextResponse.json(audit);
}
