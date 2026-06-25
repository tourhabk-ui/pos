import { NextResponse } from 'next/server';
import { getKbFreshnessStats } from '@/lib/agents/agencies/operator-agency';

export const dynamic = 'force-dynamic';

export async function GET() {
  const stats = await getKbFreshnessStats();

  const totalCount  = stats.rdc_total + stats.tours_total;
  const staleCount  = stats.rdc_stale + stats.tours_stale;
  const staleRatio  = totalCount > 0 ? staleCount / totalCount : 0;
  const lastUpdated = stats.rdc_last_updated ?? stats.tours_last_updated ?? null;

  const status =
    staleRatio > 0.5 ? 'critical' :
    staleRatio > 0.2 ? 'warn'     :
    'ok';

  return NextResponse.json({
    status,
    last_updated:  lastUpdated,
    stale_count:   staleCount,
    total_count:   totalCount,
    stale_ratio:   Math.round(staleRatio * 100) / 100,
    breakdown: {
      route_description_cache: {
        total:        stats.rdc_total,
        stale:        stats.rdc_stale,
        last_updated: stats.rdc_last_updated,
      },
      operator_tours: {
        total:        stats.tours_total,
        stale:        stats.tours_stale,
        last_updated: stats.tours_last_updated,
      },
    },
    as_of: new Date().toISOString(),
  });
}
