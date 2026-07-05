/**
 * GET /api/admin/health/air-quality-coverage — покрытие вулканических зон
 * свежими данными качества воздуха IQAir (issue #291).
 *
 * Сигнал air-quality внедрён как safety-дополнение к МЧС/КБГС-алертам, но при
 * тихом сбое ключа/квоты IQAir турист не увидит предупреждения о загрязнении —
 * этот эндпоинт делает деградацию видимой: coverage_pct < 80 → degraded.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { getCoverageStats } from '@/lib/services/air-quality';

export const dynamic = 'force-dynamic';

const DEGRADED_THRESHOLD_PCT = 80;

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  // Без ключа — честный degraded с причиной, а не фейковые 100%
  if (!process.env.IQAIR_API_KEY) {
    return NextResponse.json({
      status: 'degraded',
      reason: 'IQAIR_API_KEY не задан — сигнал качества воздуха отключён',
      total_zones: 0,
      zones_with_fresh_data: 0,
      coverage_pct: 0,
      stale_zones: [],
      zones: [],
    });
  }

  const stats = await getCoverageStats();
  return NextResponse.json({
    status: stats.coverage_pct < DEGRADED_THRESHOLD_PCT ? 'degraded' : 'ok',
    ...stats,
  });
}
