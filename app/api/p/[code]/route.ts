/**
 * GET /api/p/[code] — публичные данные подборки (без авторизации)
 * POST /api/p/[code]/event — логировать событие (open/tour_view/book_click)
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

interface RouteParams { params: Promise<{ code: string }> }

export async function GET(_req: NextRequest, { params }: RouteParams) {
  const { code } = await params;
  if (!code || code.length > 20) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const selRow = await pool.query<{
    id: string; title: string | null; client_name: string | null;
    operator_name: string | null; expires_at: string | null;
  }>(
    `SELECT s.id, s.title, s.client_name, p.name AS operator_name, s.expires_at
     FROM tour_selections s
     LEFT JOIN partners p ON p.id = s.operator_id
     WHERE s.code = $1`,
    [code],
  );

  const sel = selRow.rows[0];
  if (!sel) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (sel.expires_at && new Date(sel.expires_at) < new Date()) {
    return NextResponse.json({ error: 'Подборка устарела' }, { status: 410 });
  }

  const items = await pool.query<{
    item_id: string; tour_id: number; position: number; note: string | null;
    title: string; base_price: number; activity_type: string | null;
    duration_hours: number | null; duration_days: number | null;
    difficulty: string | null; description: string | null;
    photo_url: string | null; hazards: string[] | null;
    mchs_registration_required: boolean | null;
  }>(
    `SELECT
       si.id   AS item_id,
       ot.id   AS tour_id,
       si.position,
       si.note,
       ot.title,
       ot.base_price,
       ot.activity_type,
       ot.duration_hours,
       ot.multi_day_count AS duration_days,
       ot.difficulty,
       ot.description,
       (SELECT url FROM ai_route_images WHERE route_id = ot.route_id LIMIT 1) AS photo_url,
       kr.hazards,
       kr.mchs_registration_required
     FROM tour_selection_items si
     JOIN operator_tours ot ON ot.id = si.operator_tour_id
     LEFT JOIN kamchatka_routes kr ON kr.id = ot.route_id
     WHERE si.selection_id = $1
     ORDER BY si.position`,
    [sel.id],
  );

  return NextResponse.json({
    id:            sel.id,
    title:         sel.title,
    client_name:   sel.client_name,
    operator_name: sel.operator_name,
    expires_at:    sel.expires_at,
    tours:         items.rows,
  }, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
