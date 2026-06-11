import { NextResponse } from 'next/server';
import { query } from '@/lib/database';

/**
 * GET /api/public/safety-status
 * Public endpoint — текущий уровень опасности для главной страницы
 * Возвращает минимум данных, без деталей (ПД не передаются)
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [alertsResult, ingestResult] = await Promise.all([
      query<{
        max_severity: string;
        active_count: string;
        top_title: string | null;
        top_type: string | null;
      }>(`
        SELECT
          COALESCE(MAX(severity), 0)::text           AS max_severity,
          COUNT(*)::text                             AS active_count,
          (SELECT title FROM external_alerts
           WHERE expires_at > NOW()
           ORDER BY severity DESC, created_at DESC
           LIMIT 1)                                 AS top_title,
          (SELECT alert_type FROM external_alerts
           WHERE expires_at > NOW()
           ORDER BY severity DESC, created_at DESC
           LIMIT 1)                                 AS top_type
        FROM external_alerts
        WHERE expires_at > NOW()
      `),
      // Время последнего запуска ingest-крона — маркер свежести данных
      query<{ last_update: string | null }>(`
        SELECT MAX(updated_at)::text AS last_update FROM location_real_time_status
      `),
    ]);

    const row = alertsResult.rows[0];
    const maxSeverity = parseInt(row?.max_severity ?? '0');
    const activeCount = parseInt(row?.active_count ?? '0');
    const dataUpdatedAt = ingestResult.rows[0]?.last_update ?? null;

    return NextResponse.json({
      success: true,
      data: {
        hasAlert: activeCount > 0,
        maxSeverity,
        activeCount,
        topTitle: row?.top_title ?? null,
        topType: row?.top_type ?? null,
        dataUpdatedAt,
        source: 'КБГС РАН',
      },
    });
  } catch {
    return NextResponse.json({
      success: true,
      data: {
        hasAlert: false,
        maxSeverity: 0,
        activeCount: 0,
        topTitle: null,
        topType: null,
        dataUpdatedAt: null,
        source: 'КБГС РАН',
      },
    });
  }
}
