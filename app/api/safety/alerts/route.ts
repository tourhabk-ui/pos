import { NextResponse } from 'next/server';
import { query } from '@/lib/database';

export const dynamic = 'force-dynamic';

/**
 * GET /api/safety/alerts
 * Public — returns non-expired active alerts.
 * Severity: 1=info, 2=warning, 3=critical
 */
export async function GET() {
  try {
    const alerts = await query(`
      SELECT
        ea.id,
        ea.alert_type,
        ea.severity,
        ea.title,
        ea.description,
        ea.affected_zones,
        ea.affected_locations,
        ea.created_at,
        ea.expires_at,
        (SELECT count(*)::int FROM location_real_time_status lrs
         JOIN agent_route_knowledge ark ON ark.id = lrs.agent_route_id
         WHERE ark.zone = ANY(ea.affected_zones)) as affected_route_count
      FROM external_alerts ea
      WHERE ea.expires_at > NOW()
      ORDER BY ea.severity DESC, ea.created_at DESC
      LIMIT 100
    `);

    const rows = alerts.rows as Array<{severity: number}>;
    const criticalCount = rows.filter((r) => r.severity >= 2).length;

    return NextResponse.json(
      { success: true, data: rows, meta: { total: rows.length, active_critical: criticalCount } },
      { headers: { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=120' } },
    );
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}
