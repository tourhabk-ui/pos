/**
 * GET /api/admin/health/rescue-coverage
 *
 * Health-метрика (issue #247): доля маршрутов с телефоном МЧС для
 * регистрации/консультации (mchs_phone) — прямой вклад в безопасность.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { computeRescueCoverage } from '@/lib/services/rescue-coverage';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const coverage = await computeRescueCoverage();
  return NextResponse.json(coverage);
}
