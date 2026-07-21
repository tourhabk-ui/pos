/**
 * GET /api/admin/health/air-quality
 *
 * Качество воздуха по вулканическим зонам Камчатки (IQAir) — дополнительный
 * сигнал к МЧС/КБГС-алертам о вулканической активности. Требует IQAIR_API_KEY;
 * без ключа возвращает пустой список (не ошибку — ключ опционален).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { getAllZonesAirQuality } from '@/lib/services/safety/air-quality';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const zones = await getAllZonesAirQuality();
  return NextResponse.json({
    configured: !!process.env.IQAIR_API_KEY,
    zones,
  });
}
