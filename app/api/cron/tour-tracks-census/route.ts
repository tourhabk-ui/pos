/**
 * GET /api/cron/tour-tracks-census — у каких туров операторов нет линии.
 *
 * Основа письма операторам за GPX (решение владельца 20.08): просить трек
 * имеет смысл только там, где его нет, и просить конкретно — «по туру X
 * маршрут не привязан», «по туру Y маршрут есть, но линии нет», а не
 * «пришлите что-нибудь». Для каждого живого тура: оператор, маршрут,
 * есть ли у маршрута геометрия и какого она рода (source).
 *
 * Род линии здесь не пересуживается — печатается сырой source; чем судить
 * (track/sketch/unknown), решает lib/map/line-standard на витрине.
 *
 * READ-ONLY, Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { rows } = await pool.query<{
      tour_id: string; tour_title: string; operator_name: string | null;
      route_id: string | null; route_title: string | null;
      has_line: boolean | null; geometry_source: string | null;
    }>(
      `SELECT t.id::text AS tour_id, t.title AS tour_title,
              p.name AS operator_name,
              r.id::text AS route_id, r.title AS route_title,
              CASE WHEN r.id IS NULL THEN NULL ELSE (r.geometry IS NOT NULL) END AS has_line,
              r.geometry->>'source' AS geometry_source
       FROM operator_tours t
       LEFT JOIN partners p ON p.id = t.operator_id
       LEFT JOIN kamchatka_routes r
         ON r.id = t.route_id AND r.merged_into_id IS NULL
       WHERE t.deleted_at IS NULL
       ORDER BY p.name NULLS LAST, t.title`,
    );

    // Три судьбы тура — и у каждой свой абзац в письме:
    //   no_route  — маршрут не привязан вовсе: не знаем, куда он ведёт;
    //   no_line   — маршрут есть, линии нет: GPX ляжет сразу;
    //   has_line  — линия есть (родом какая есть) — просить нечего.
    const noRoute = rows.filter(r => r.route_id === null);
    const noLine = rows.filter(r => r.route_id !== null && r.has_line === false);
    const hasLine = rows.filter(r => r.has_line === true);

    return NextResponse.json({
      success: true,
      probe: 'tour_tracks_v1',
      tours_total: rows.length,
      no_route: noRoute.length,
      no_line: noLine.length,
      has_line: hasLine.length,
      items: rows,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка переписи треков туров';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
