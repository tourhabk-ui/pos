/**
 * GET /api/admin/health/routes-geometry
 *
 * Health-метрика (issue #249): доля v_kamchatka_routes_api с валидным треком
 * (GeoJSON LineString, ≥2 точек) — маршруты-заглушки без трека не работают
 * офлайн на карте, что важно для safety до выхода туриста на тропу.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { computeGeometryHealth } from '@/lib/services/routes/routes-geometry-health';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const health = await computeGeometryHealth();
  return NextResponse.json(health);
}
