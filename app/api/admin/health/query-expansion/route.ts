/**
 * GET /api/admin/health/query-expansion
 *
 * Health-метрика (issue #250): за 7 дней — среднее число вариантов
 * multi-query расширения (RAG_MULTIQUERY) и доля запросов, где расширение
 * добавило хотя бы один уникальный маршрут поверх базового запроса.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { computeQueryExpansionHealth } from '@/lib/services/query-expansion-health';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const health = await computeQueryExpansionHealth();
  return NextResponse.json(health);
}
